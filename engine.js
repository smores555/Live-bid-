/**
 * AIRLINE BID ENGINE - LIVE LEDGER EDITION
 * FIXED VERSION
 */
function runBidEngine(data, deltaMap) {
    const auditTrail = [];
    
    // Safety check for missing data
    if (!data || !data.roster) {
        console.error("Bid Engine Error: Missing required roster data.");
        return { roster: [], loops: 0, auditTrail: [], targetMap: {} };
    }

    const is737 = (seat) => seat && !seat.includes('320') && !seat.includes('321');
    
    // Safety filters for retirement and no-bid lists
    const retiredSens = new Set((data.retired || []).filter(p => is737(p.seat)).map(p => p.seniority));
    const noBidSens   = new Set((data.noBid || []).filter(p => is737(p.seat)).map(p => p.sen));
    
    const activeBidders = data.roster.filter(p =>
        is737(p.current.seat) && !retiredSens.has(p.sen) && !noBidSens.has(p.sen)
    );

    const baseNames = {
        ANC: 'Anchorage', SEA: 'Seattle',       LAX: 'Los Angeles',
        SAN: 'San Diego', SFO: 'San Francisco',  PDX: 'Portland',
        LAS: 'Las Vegas'
    };
    const seatNames = { CA: 'Captain', FO: 'First Officer' };

    function keyLabel(key) {
        const [base, seat] = (key || '').split('-');
        return `${base} ${seat}`;
    }

    function posLabel(key) {
        const [base, seat] = (key || '').split('-');
        return `${baseNames[base] || base} ${seatNames[seat] || seat}`;
    }

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

    let liveHeadcount = {};
    activeBidders.forEach(p => {
        const key = `${p.current.base}-${p.current.seat}`.toUpperCase();
        liveHeadcount[key] = (liveHeadcount[key] || 0) + 1;
    });

    let targetMap = {};
    Object.keys(liveHeadcount).forEach(key => {
        targetMap[key] = liveHeadcount[key] + (deltaMap[key] || 0);
    });
    
    (data.caps || []).forEach(c => {
        const key = `${c.base}-${c.seat}`.toUpperCase();
        if (targetMap[key] === undefined) {
            targetMap[key] = (c.startCapacity || 0) + (deltaMap[key] || 0);
        }
    });

    Object.keys(targetMap).forEach(key => {
        const preExisting = (targetMap[key] || 0) - (liveHeadcount[key] || 0);
        slotSources[key] = [];
        for (let i = 0; i < preExisting; i++) {
            slotSources[key].push({ type: 'vacancy', label: 'retirement / system reduction' });
        }
    });

    let currentCounts = { ...liveHeadcount };
    const getVac = (key) => (targetMap[key] || 0) - (currentCounts[key] || 0);

    const bidders = activeBidders.map(p => {
        const prefData  = data.prefs['pil' + p.sen] || data.prefs[p.id] || { preferences: [] };
        const pilotOrig = `${p.current.base}-${p.current.seat}`.toUpperCase();

        const getTargetKey = (bidStr) => {
            if (!bidStr) return null;
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
            moveLog: null,
            prefs: (prefData.preferences || []).map(pr => {
                let limit = parseInt(pr.bpl || pr.bpl_min);
                if (isNaN(limit) || limit === 0) limit = 9999;
                return { ...pr, targetKey: getTargetKey(pr.bid), bpl: limit };
            }).sort((a, b) => a.order - b.order)
        };
    }).sort((a, b) => a.sen - b.sen);

    let cascade = true;
    let loops   = 0;

    while (cascade) {
        cascade = false;
        loops++;

        for (let i = 0; i < bidders.length; i++) {
            const p = bidders[i];
            let awarded  = false;
            let newSeat  = null;
            let log      = null;
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
                        log = (p.orig === targetKey) 
                            ? { step: 'A', prefOrder: pr.order, fromKey: null, toKey: targetKey, stayed: true }
                            : p.moveLog; 
                    }
                    break; 
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
                            log = p.moveLog;
                        }
                        break; 
                    }
                } // Fixed missing closing brace for the options loop
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
    bidders.forEach(p => {
        const log = p.moveLog;
        if (!log) { p.awardedReason = "No bid data."; return; }

        const finalVac = (key) => (targetMap[key] || 0) - (currentCounts[key] || 0);

        if (log.step === 'A' && !log.stayed) {
            const lines = [
                `Awarded Pref #${log.prefOrder} \u2014 ${posLabel(log.toKey)}.`,
                `${fmtSource(log.source)}`,
                `Reduce vacancy in ${keyLabel(log.toKey)} from ${log.vacToBefore} to ${log.vacToBefore - 1}.`,
                `Increase vacancy in ${keyLabel(log.fromKey)} from ${log.vacFromBefore} to ${log.vacFromBefore + 1}.`
            ];
            p.awardedReason = lines.join(' ');
        } else if (log.step === 'A' && log.stayed) {
            const vac = finalVac(log.toKey);
            const cap = targetMap[log.toKey] || 0;
            p.awardedReason = `Awarded Pref #${log.prefOrder} \u2014 Remained in ${posLabel(log.toKey)}. ${keyLabel(log.toKey)} vacancy: ${vac} open of ${cap}.`;
        } else if (log.step === 'B') {
            const vac = finalVac(log.toKey);
            const cap = targetMap[log.toKey] || 0;
            p.awardedReason = `Held Position (Seniority) \u2014 ${posLabel(log.toKey)}. ${keyLabel(log.toKey)} vacancy: ${vac} open of ${cap}.`;
        } else if (log.step === 'C') {
            const lines = [
                `Section 24 Displacement \u2192 ${posLabel(log.toKey)}.`,
                `${fmtSource(log.source)}`,
                `Reduce vacancy in ${keyLabel(log.toKey)} from ${log.vacToBefore} to ${log.vacToBefore - 1}.`,
                `Increase vacancy in ${keyLabel(log.fromKey)} from ${log.vacFromBefore} to ${log.vacFromBefore + 1}.`
            ];
            p.awardedReason = lines.join(' ');
        } else if (log.step === 'D') {
            if (log.selfDisp) {
                p.awardedReason = `BPL Failure \u2014 Rank ${log.bplRank} exceeds limit of ${log.bplLimit} for ${posLabel(log.origKey)}. Increase vacancy in ${keyLabel(log.fromKey)} from ${log.vacFromBefore} to ${log.vacFromBefore + 1}.`;
            } else {
                p.awardedReason = `Displaced: System-wide reduction \u2014 no position available. Increase vacancy in ${keyLabel(log.fromKey)} from ${log.vacFromBefore} to ${log.vacFromBefore + 1}.`;
            }
        }
    });

    return { roster: bidders, loops, auditTrail, targetMap };
}
