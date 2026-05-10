/**
 * AIRLINE BID ENGINE - LIVE LEDGER EDITION
 *
 * Award Path is built from two layers:
 *
 *  1. p.moveLog  — immutable record written at the EXACT moment a pilot moves.
 *                  Contains vacancy numbers snapshotted at that instant.
 *                  This is the auditable ground truth.
 *
 *  2. p.awardedReason — final human-readable string assembled AFTER the cascade
 *                       settles, so stayed/held pilots reflect final vacancy state
 *                       rather than a stale mid-cascade snapshot.
 *
 * Award Path format (movers):
 *   "Awarded Pref #1 — Portland First Officer.
 *    Reduce vacancy in PDX FO from 7 to 6.
 *    Increase vacancy in SEA CA from 0 to 1.
 *    Proffered from Sen #88 - JONES, ROBERT."
 *
 * Award Path format (stayed / held):
 *   "Held Position (Seniority) — Seattle Captain.
 *    Seattle CA vacancy: 44 open of 761."
 */
function runBidEngine(data, deltaMap) {
    const auditTrail = [];
    const is737 = (seat) => seat && !seat.includes('320') && !seat.includes('321');
    const retiredSens = new Set(data.retired.filter(p => is737(p.seat)).map(p => p.seniority));
    const noBidSens   = new Set(data.noBid.filter(p => is737(p.seat)).map(p => p.sen));
    const activeBidders = data.roster.filter(p =>
        is737(p.current.seat) && !retiredSens.has(p.sen) && !noBidSens.has(p.sen)
    );

    // ── LABEL HELPERS ────────────────────────────────────────────────────────
    const baseNames = {
        ANC: 'Anchorage', SEA: 'Seattle',       LAX: 'Los Angeles',
        SAN: 'San Diego', SFO: 'San Francisco',  PDX: 'Portland',
        LAS: 'Las Vegas'
    };
    const seatNames = { CA: 'Captain', FO: 'First Officer' };

    // Short form used inside ledger lines: "SEA CA", "PDX FO"
    function keyLabel(key) {
        const [base, seat] = (key || '').split('-');
        return `${base} ${seat}`;
    }

    // Long form used in headers: "Seattle Captain"
    function posLabel(key) {
        const [base, seat] = (key || '').split('-');
        return `${baseNames[base] || base} ${seatNames[seat] || seat}`;
    }

    // ── SLOT SOURCE TRACKER ──────────────────────────────────────────────────
    // FIFO queue per position — tracks where each open slot came from.
    //   { type: 'vacancy', label: 'retirement / system reduction' }
    //   { type: 'pilot',   sen: number, name: string }
    let slotSources = {};

    function consumeSlot(key) {
        if (!slotSources[key]) slotSources[key] = [];
        return slotSources[key].length > 0
            ? slotSources[key].shift()
            : { type: 'vacancy', label: 'retirement / system reduction' };
    }

    function releaseSlot(key, pilotSen, pilotName) {
        if (!slotSources[key]) slotSources[key] = [];
        slotSources[key].push({ type: 'pilot', sen: pilotSen, name: pilotName });
    }

    function fmtSource(src) {
        if (!src) return 'Source unknown.';
        if (src.type === 'pilot') return `Proffered from Sen #${src.sen} - ${src.name}.`;
        return `Open position available (${src.label}).`;
    }

    // ── HEADCOUNT & TARGET MAP ───────────────────────────────────────────────
    let liveHeadcount = {};
    activeBidders.forEach(p => {
        const key = `${p.current.base}-${p.current.seat}`.toUpperCase();
        liveHeadcount[key] = (liveHeadcount[key] || 0) + 1;
    });

    let targetMap = {};
    Object.keys(liveHeadcount).forEach(key => {
        targetMap[key] = liveHeadcount[key] + (deltaMap[key] || 0);
    });
    data.caps.forEach(c => {
        const key = `${c.base}-${c.seat}`.toUpperCase();
        if (targetMap[key] === undefined) {
            targetMap[key] = c.startCapacity + (deltaMap[key] || 0);
        }
    });

    // Seed pre-existing vacancies (from delta / retirements)
    Object.keys(targetMap).forEach(key => {
        const preExisting = (targetMap[key] || 0) - (liveHeadcount[key] || 0);
        slotSources[key] = [];
        for (let i = 0; i < preExisting; i++) {
            slotSources[key].push({ type: 'vacancy', label: 'retirement / system reduction' });
        }
    });

    let currentCounts = { ...liveHeadcount };
    const getVac = (key) => (targetMap[key] || 0) - (currentCounts[key] || 0);

    // ── BUILD BIDDER LIST ────────────────────────────────────────────────────
    const bidders = activeBidders.map(p => {
        const prefData  = data.prefs['pil' + p.sen] || data.prefs[p.id] || { preferences: [] };
        const pilotOrig = `${p.current.base}-${p.current.seat}`.toUpperCase();

        const getTargetKey = (bidStr) => {
            const parts = bidStr.trim().toUpperCase().split(/\s+/);
            const bases = ['ANC', 'SEA', 'LAX', 'SAN', 'SFO', 'PDX', 'LAS'];
            const seats = ['CA', 'FO'];
            const b = parts.find(x => bases.includes(x));
            const s = parts.find(x => seats.includes(x));
            return (b && s) ? `${b}-${s}` : null;
        };

        return {
            ...p,
            orig: pilotOrig,
            currentKey: pilotOrig,
            moved: false,
            isUnassigned: false,
            awardedPrefNum: "N/A",
            awardedReason: "Pending...",
            wasSelfDisplaced: false,
            // moveLog stores the immutable snapshot written at move-moment:
            // { step, prefOrder, fromKey, toKey, vacFromBefore, vacToBefore, source, bplRank, bplLimit }
            moveLog: null,
            prefs: (prefData.preferences || []).map(pr => {
                let limit = parseInt(pr.bpl || pr.bpl_min);
                if (isNaN(limit) || limit === 0) limit = 9999;
                return { ...pr, targetKey: getTargetKey(pr.bid), bpl: limit };
            }).sort((a, b) => a.order - b.order)
        };
    }).sort((a, b) => a.sen - b.sen);

    // ── SENIORITY CASCADE ────────────────────────────────────────────────────
    let cascade = true;
    let loops   = 0;

    while (cascade) {
        cascade = false;
        loops++;

        for (let i = 0; i < bidders.length; i++) {
            const p = bidders[i];
            let awarded  = false;
            let newSeat  = null;
            let log      = null;   // will become p.moveLog
            let prefNum  = "N/A";
            let selfDisp = false;
            const [origBase, origStatus] = p.orig.split('-');

          // ── STEP A: Primary Preference Bids ──────────────────────────────
            for (const pr of p.prefs) {
                if (!pr.targetKey) continue;
                const targetKey  = pr.targetKey;
                const cap        = targetMap[targetKey] || 0;
                const isMovingIn = (p.currentKey !== targetKey);

                let rank = 1;
                for (const other of bidders) {
                    if (other.sen >= p.sen) break;
                    if (other.currentKey === targetKey) rank++;
                }

                const vacancyOk = isMovingIn ? getVac(targetKey) > 0 : true;

                if (rank <= pr.bpl && rank <= cap && vacancyOk) {
                    newSeat = targetKey;
                    prefNum = pr.order;
                    awarded = true;

                    if (isMovingIn) {
                        const src = consumeSlot(targetKey);
                        log = {
                            step: 'A',
                            prefOrder: pr.order,
                            fromKey: p.currentKey,
                            toKey: targetKey,
                            vacFromBefore: getVac(p.currentKey),
                            vacToBefore: getVac(targetKey),
                            source: src
                        };
                    } else {
                        // ── THE FIX: Check if they moved here during an earlier loop ──
                        if (p.orig === targetKey) {
                            // They truly stayed in their original seat
                            log = { step: 'A', prefOrder: pr.order, fromKey: null, toKey: targetKey, stayed: true };
                        } else {
                            // They moved here earlier in the cascade. Preserve the detailed log!
                            log = p.moveLog; 
                        }
                    }
                    break; // <-- THIS BREAK IS CRITICAL! It stops the loop from overwriting the log.
                }
            }
            // ── STEP B: Seniority Hold ────────────────────────────────────────
            if (!awarded) {
                const cap = targetMap[p.orig] || 0;
                let rank  = 1;
                for (const other of bidders) {
                    if (other.sen >= p.sen) break;
                    if (other.currentKey === p.orig) rank++;
                }
                const selfBid  = p.prefs.find(pr => pr.targetKey === p.orig);
                const bplLimit = selfBid ? selfBid.bpl : 9999;

                if (rank <= bplLimit && rank <= cap) {
                    newSeat = p.orig;
                    awarded = true;
                    log = { step: 'B', fromKey: null, toKey: p.orig, stayed: true };
                }
            }

            // ── STEP C: Section 24 Secondary Displacement ────────────────────
            if (!awarded) {
                const cascadeOptions = [
                    ...['ANC', 'SEA', 'LAX', 'SAN', 'SFO', 'PDX', 'LAS']
                        .filter(b => b !== origBase).map(b => `${b}-${origStatus}`),
                    `${origBase}-FO`,
                    ...['ANC', 'SEA', 'LAX', 'SAN', 'SFO', 'PDX', 'LAS']
                        .filter(b => b !== origBase).map(b => `${b}-FO`)
                ];

                for (const targetKey of cascadeOptions) {
                    if (targetMap[targetKey] === undefined) continue;
                    const cap        = targetMap[targetKey] || 0;
                    const isMovingIn = (p.currentKey !== targetKey);

                    let rank = 1;
                    for (const other of bidders) {
                        if (other.sen >= p.sen) break;
                        if (other.currentKey === targetKey) rank++;
                    }

                    const vacancyOk = isMovingIn ? getVac(targetKey) > 0 : true;

                 if (rank <= cap && vacancyOk) {
                        newSeat = targetKey;
                        awarded = true;
                        
                        // ── THE FIX: Only consume a slot and write a new log if actually moving in ──
                        if (isMovingIn) {
                            const src = consumeSlot(targetKey);
                            log = {
                                step: 'C',
                                fromKey: p.currentKey,
                                toKey: targetKey,
                                vacFromBefore: getVac(p.currentKey),
                                vacToBefore: getVac(targetKey),
                                source: src
                            };
                        } else {
                            // Preserve the log if they already moved here in an earlier loop
                            log = p.moveLog;
                        }
                        break; 
                    }

            // ── STEP D: Pool (Unassigned) ─────────────────────────────────────
            if (!awarded) {
                newSeat = "UNASSIGNED";
                let rank = 1;
                for (const other of bidders) {
                    if (other.sen >= p.sen) break;
                    if (other.currentKey === p.orig) rank++;
                }
                const selfBid = p.prefs.find(pr => pr.targetKey === p.orig);
                selfDisp = selfBid && rank > selfBid.bpl;
                log = {
                    step: 'D',
                    fromKey: p.currentKey,
                    toKey: 'UNASSIGNED',
                    vacFromBefore: getVac(p.currentKey),
                    selfDisp,
                    bplRank: rank,
                    bplLimit: selfBid ? selfBid.bpl : null,
                    origKey: p.orig
                };
            }

            // ── STATE UPDATE ──────────────────────────────────────────────────
            p.awardedPrefNum   = prefNum;
            p.wasSelfDisplaced = selfDisp;
            p.moveLog          = log;

            if (newSeat !== p.currentKey) {
                if (p.currentKey !== "UNASSIGNED") {
                    releaseSlot(p.currentKey, p.sen, p.name);
                    currentCounts[p.currentKey]--;
                }
                if (newSeat !== "UNASSIGNED") {
                    currentCounts[newSeat] = (currentCounts[newSeat] || 0) + 1;
                }

                p.currentKey   = newSeat;
                p.moved        = (newSeat !== p.orig);
                p.isUnassigned = (newSeat === "UNASSIGNED");

                auditTrail.push({ loop: loops, sen: p.sen, name: p.name, to: newSeat, log });

                cascade = true;
                break;
            } else {
                p.moved        = (p.currentKey !== p.orig);
                p.isUnassigned = (p.currentKey === "UNASSIGNED");
            }
        }

        if (loops > 10000) break;
    }

    // ── BUILD FINAL REASON STRINGS ───────────────────────────────────────────
    // Now that the cascade is fully settled, write awardedReason for every pilot.
    // Movers use the immutable snapshot from moveLog (captured at move-moment).
    // Stayed/held pilots use the final live vacancy count.

    bidders.forEach(p => {
        const log = p.moveLog;
        if (!log) { p.awardedReason = "No bid data."; return; }

        const finalVac = (key) => (targetMap[key] || 0) - (currentCounts[key] || 0);

        if (log.step === 'A' && !log.stayed) {
            // Moved via preference bid
            const lines = [
                `Awarded Pref #${log.prefOrder} \u2014 ${posLabel(log.toKey)}.`,
                `${fmtSource(log.source)}`,
                `Reduce vacancy in ${keyLabel(log.toKey)} from ${log.vacToBefore} to ${log.vacToBefore - 1}.`,
                `Increase vacancy in ${keyLabel(log.fromKey)} from ${log.vacFromBefore} to ${log.vacFromBefore + 1}.`
            ];
            p.awardedReason = lines.join(' ');

        } else if (log.step === 'A' && log.stayed) {
            // Preference bid, stayed in same position
            const vac = finalVac(log.toKey);
            const cap = targetMap[log.toKey] || 0;
            p.awardedReason = `Awarded Pref #${log.prefOrder} \u2014 Remained in ${posLabel(log.toKey)}. ${keyLabel(log.toKey)} vacancy: ${vac} open of ${cap}.`;

        } else if (log.step === 'B') {
            // Held by seniority
            const vac = finalVac(log.toKey);
            const cap = targetMap[log.toKey] || 0;
            p.awardedReason = `Held Position (Seniority) \u2014 ${posLabel(log.toKey)}. ${keyLabel(log.toKey)} vacancy: ${vac} open of ${cap}.`;

        } else if (log.step === 'C') {
            // Section 24 displacement move
            const lines = [
                `Section 24 Displacement \u2192 ${posLabel(log.toKey)}.`,
                `${fmtSource(log.source)}`,
                `Reduce vacancy in ${keyLabel(log.toKey)} from ${log.vacToBefore} to ${log.vacToBefore - 1}.`,
                `Increase vacancy in ${keyLabel(log.fromKey)} from ${log.vacFromBefore} to ${log.vacFromBefore + 1}.`
            ];
            p.awardedReason = lines.join(' ');

        } else if (log.step === 'D') {
            // Displaced / unassigned
            if (log.selfDisp) {
                p.awardedReason = `BPL Failure \u2014 Rank ${log.bplRank} exceeds limit of ${log.bplLimit} for ${posLabel(log.origKey)}. Increase vacancy in ${keyLabel(log.fromKey)} from ${log.vacFromBefore} to ${log.vacFromBefore + 1}.`;
            } else {
                p.awardedReason = `Displaced: System-wide reduction \u2014 no position available. Increase vacancy in ${keyLabel(log.fromKey)} from ${log.vacFromBefore} to ${log.vacFromBefore + 1}.`;
            }
        }
    });

    return { roster: bidders, loops, auditTrail, targetMap };
}
