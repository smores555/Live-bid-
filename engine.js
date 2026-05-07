/**
 * AIRLINE BID ENGINE - VACANCY LEDGER + SOURCE ATTRIBUTION EDITION
 *
 * Features:
 * 1. True top-down cascade: restart from Sen #1 on any move.
 * 2. Strict cap: rank must be <= targetMap capacity.
 * 3. Vacancy gate: moving INTO a position requires vacancy > 0.
 * 4. Holding your own base never requires a vacancy (you are already there).
 * 5. Human-readable vacancy ledger in EVERY Award Path row, including
 *    stayed-in-place and held pilots:
 *      "Held Position (Seniority) — Seattle Captain.
 *       Seattle Captain: 44 of 761 slots open."
 *    For movers:
 *      "Decrease San Diego Captain vacancy 18 → 17.
 *       Increase Portland Captain vacancy 0 → 1."
 * 6. Source attribution on every inbound move:
 *      "Slot proffered from: SMITH, JOHN (Sen #142)"
 *      "Slot from vacancy (retirement / system reduction)"
 */
function runBidEngine(data, deltaMap) {
    const auditTrail = [];
    const is737 = (seat) => seat && !seat.includes('320') && !seat.includes('321');
    const retiredSens = new Set(data.retired.filter(p => is737(p.seat)).map(p => p.seniority));
    const noBidSens   = new Set(data.noBid.filter(p => is737(p.seat)).map(p => p.sen));
    const activeBidders = data.roster.filter(p =>
        is737(p.current.seat) && !retiredSens.has(p.sen) && !noBidSens.has(p.sen)
    );

    // ── POSITION LABEL LOOKUP ────────────────────────────────────────────────
    const baseNames = {
        ANC: 'Anchorage', SEA: 'Seattle',        LAX: 'Los Angeles',
        SAN: 'San Diego', SFO: 'San Francisco',   PDX: 'Portland',
        LAS: 'Las Vegas'
    };
    const seatNames = { CA: 'Captain', FO: 'First Officer' };

    function posLabel(key) {
        const [base, seat] = (key || '').split('-');
        return `${baseNames[base] || base} ${seatNames[seat] || seat}`;
    }

    // Builds the two ledger lines for a pilot actually moving between positions.
    function moveLedger(fromKey, toKey, vacToBefore, vacFromBefore) {
        const lines = [];
        if (toKey && toKey !== 'UNASSIGNED') {
            lines.push(`Decrease ${posLabel(toKey)} vacancy ${vacToBefore} \u2192 ${vacToBefore - 1}`);
        }
        if (fromKey && fromKey !== 'UNASSIGNED') {
            lines.push(`Increase ${posLabel(fromKey)} vacancy ${vacFromBefore} \u2192 ${vacFromBefore + 1}`);
        }
        return lines.join('. ') + (lines.length ? '.' : '');
    }

    // ── SLOT SOURCE TRACKER ──────────────────────────────────────────────────
    // FIFO queue per position key.
    //   { type: 'vacancy', label: '...' }        - pre-existing open slot
    //   { type: 'pilot',   name: str, sen: num } - opened when a pilot departed
    let slotSources = {};

    function consumeSlot(key) {
        if (!slotSources[key]) slotSources[key] = [];
        return slotSources[key].length > 0
            ? slotSources[key].shift()
            : { type: 'vacancy', label: 'retirement / system reduction' };
    }

    function releaseSlot(key, pilotName, pilotSen) {
        if (!slotSources[key]) slotSources[key] = [];
        slotSources[key].push({ type: 'pilot', name: pilotName, sen: pilotSen });
    }

    function attribution(src) {
        if (!src) return 'Slot source unknown.';
        if (src.type === 'pilot') return `Slot proffered from: ${src.name} (Sen #${src.sen}).`;
        return `Slot from vacancy (${src.label}).`;
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

    // Seed slot sources with pre-existing open slots (delta / retirements)
    Object.keys(targetMap).forEach(key => {
        const preExisting = (targetMap[key] || 0) - (liveHeadcount[key] || 0);
        slotSources[key] = [];
        for (let i = 0; i < preExisting; i++) {
            slotSources[key].push({ type: 'vacancy', label: 'retirement / system reduction' });
        }
    });

    let currentCounts = { ...liveHeadcount };

    // Live vacancy = target cap minus how many pilots are currently sitting there.
    // For a pilot who has NOT moved, they are already counted in currentCounts,
    // so getVac() correctly returns the remaining open slots excluding themselves.
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
            let reason   = "";
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

                // Vacancy gate: inbound moves need a real open slot
                const vacancyOk = isMovingIn ? getVac(targetKey) > 0 : true;

                if (rank <= pr.bpl && rank <= cap && vacancyOk) {
                    newSeat = targetKey;

                    if (isMovingIn) {
                        // Moving to a different position — full ledger + attribution
                        const vacToBefore  = getVac(targetKey);
                        const vacFrmBefore = getVac(p.currentKey);
                        const src = consumeSlot(targetKey);
                        reason = [
                            `Awarded Pref #${pr.order} \u2014 ${posLabel(targetKey)}.`,
                            moveLedger(p.currentKey, targetKey, vacToBefore, vacFrmBefore),
                            attribution(src)
                        ].join(' ');
                    } else {
                        // Stayed in current position — show live vacancy snapshot
                        const remVac = getVac(p.currentKey);
                        const capNow = targetMap[p.currentKey] || 0;
                        reason = `Awarded Pref #${pr.order} \u2014 Remained in ${posLabel(p.currentKey)}. ${posLabel(p.currentKey)} vacancy: ${remVac} of ${capNow} slots open.`;
                    }
                    prefNum = pr.order;
                    awarded = true;
                    break;
                }
            }

            // ── STEP B: Seniority Hold ────────────────────────────────────────
            // Pilot stays in their original base — no vacancy needed.
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
                    // Pilot is already in currentCounts, so getVac = remaining open slots
                    const remVac = getVac(p.orig);
                    reason = `Held Position (Seniority) \u2014 ${posLabel(p.orig)}. ${posLabel(p.orig)} vacancy: ${remVac} of ${cap} slots open.`;
                    awarded = true;
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
                        const vacToBefore  = getVac(targetKey);
                        const vacFrmBefore = getVac(p.currentKey);
                        const src = consumeSlot(targetKey);
                        reason = [
                            `Section 24 Displacement \u2192 ${posLabel(targetKey)}.`,
                            moveLedger(p.currentKey, targetKey, vacToBefore, vacFrmBefore),
                            attribution(src)
                        ].join(' ');
                        awarded = true;
                        break;
                    }
                }
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

                const curVac   = getVac(p.currentKey);
                const baseText = `Increase ${posLabel(p.currentKey)} vacancy ${curVac} \u2192 ${curVac + 1}.`;
                reason = selfDisp
                    ? `BPL Failure \u2014 Rank ${rank} exceeds limit of ${selfBid.bpl} for ${posLabel(p.orig)}. ${baseText}`
                    : `Displaced: System-wide reduction \u2014 no position available. ${baseText}`;
            }

            // ── STATE UPDATE ──────────────────────────────────────────────────
            p.awardedReason    = reason;
            p.awardedPrefNum   = prefNum;
            p.wasSelfDisplaced = selfDisp;

            if (newSeat !== p.currentKey) {
                // Pilot leaving — record them as the slot source for that position
                if (p.currentKey !== "UNASSIGNED") {
                    releaseSlot(p.currentKey, p.name, p.sen);
                    currentCounts[p.currentKey]--;
                }
                // Pilot arriving
                if (newSeat !== "UNASSIGNED") {
                    currentCounts[newSeat] = (currentCounts[newSeat] || 0) + 1;
                }

                p.currentKey   = newSeat;
                p.moved        = (newSeat !== p.orig);
                p.isUnassigned = (newSeat === "UNASSIGNED");

                auditTrail.push({ loop: loops, sen: p.sen, name: p.name, to: newSeat, reason });

                cascade = true; // Restart from Sen #1
                break;
            } else {
                p.moved        = (p.currentKey !== p.orig);
                p.isUnassigned = (p.currentKey === "UNASSIGNED");
            }
        }

        if (loops > 10000) break; // Safety valve
    }

    return { roster: bidders, loops, auditTrail, targetMap };
}
