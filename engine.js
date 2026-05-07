/**
 * AIRLINE BID ENGINE - STRICT CAP + VACANCY GATE EDITION
 *
 * KEY FIX: "Vacancy Gate" on all inbound moves.
 * A pilot moving INTO a base (not already sitting there) now requires
 * an ACTUAL vacancy (currentCounts < targetMap). This prevents senior
 * pilots from pushing into stable/zero-delta bases and illegally
 * displacing junior pilots who have every right to hold their seat.
 *
 * Rules enforced:
 * 1. True top-down cascade: restart from Sen #1 on any move.
 * 2. Strict cap: rank must be <= targetMap capacity.
 * 3. Vacancy gate: moving INTO a position requires vacancy > 0.
 * 4. Holding your own base never requires a vacancy (you're already there).
 */
function runBidEngine(data, deltaMap) {
    const auditTrail = [];
    const is737 = (seat) => seat && !seat.includes('320') && !seat.includes('321');
    const retiredSens = new Set(data.retired.filter(p => is737(p.seat)).map(p => p.seniority));
    const noBidSens = new Set(data.noBid.filter(p => is737(p.seat)).map(p => p.sen));
    const activeBidders = data.roster.filter(p =>
        is737(p.current.seat) && !retiredSens.has(p.sen) && !noBidSens.has(p.sen)
    );

    // 1. Calculate LIVE headcount
    let liveHeadcount = {};
    activeBidders.forEach(p => {
        const key = `${p.current.base}-${p.current.seat}`.toUpperCase();
        liveHeadcount[key] = (liveHeadcount[key] || 0) + 1;
    });

    // 2. Align Target Map strictly to Live Headcount + Delta
    let targetMap = {};
    Object.keys(liveHeadcount).forEach(key => {
        const delta = deltaMap[key] || 0;
        targetMap[key] = liveHeadcount[key] + delta;
    });
    data.caps.forEach(c => {
        const key = `${c.base}-${c.seat}`.toUpperCase();
        if (targetMap[key] === undefined) {
            targetMap[key] = c.startCapacity + (deltaMap[key] || 0);
        }
    });

    // 3. Initialize running counts (mirrors liveHeadcount at start)
    let currentCounts = { ...liveHeadcount };

    // Helper: how many open slots exist in a position right now
    const getVac = (key) => (targetMap[key] || 0) - (currentCounts[key] || 0);

    // 4. Map Bidders & Format Preferences
    const bidders = activeBidders.map(p => {
        const prefData = data.prefs['pil' + p.sen] || data.prefs[p.id] || { preferences: [] };
        const pilotOrig = `${p.current.base}-${p.current.seat}`.toUpperCase();

        const getTargetKey = (bidStr) => {
            const parts = bidStr.trim().toUpperCase().split(/\s+/);
            const bases = ['ANC', 'SEA', 'LAX', 'SAN', 'SFO', 'PDX', 'LAS'];
            const seats = ['CA', 'FO'];
            let b = parts.find(x => bases.includes(x));
            let s = parts.find(x => seats.includes(x));
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
                if (isNaN(limit) || limit === 0) limit = 9999; // BPL 0 = No Limit
                return { ...pr, targetKey: getTargetKey(pr.bid), bpl: limit };
            }).sort((a, b) => a.order - b.order)
        };
    }).sort((a, b) => a.sen - b.sen);

    let cascade = true;
    let loops = 0;

    // 5. Seniority Cascade
    while (cascade) {
        cascade = false;
        loops++;

        for (let i = 0; i < bidders.length; i++) {
            const p = bidders[i];
            let awarded = false;
            let newSeat = null;
            let reason = "";
            let prefNum = "N/A";
            let selfDisp = false;
            const [origBase, origStatus] = p.orig.split('-');

            // ─── STEP A: Primary Preference Bids ────────────────────────────
            for (const pr of p.prefs) {
                if (!pr.targetKey) continue;
                const targetKey = pr.targetKey;
                const cap = targetMap[targetKey] || 0;
                const isMovingIn = (p.currentKey !== targetKey);

                // Count how many pilots senior to this one are already in targetKey
                let rank = 1;
                for (const other of bidders) {
                    if (other.sen >= p.sen) break;
                    if (other.currentKey === targetKey) rank++;
                }

                // VACANCY GATE: if moving into a different position, a real
                // vacancy must exist. Holding your current seat is always free.
                const vacancyOk = isMovingIn ? getVac(targetKey) > 0 : true;

                if (rank <= pr.bpl && rank <= cap && vacancyOk) {
                    newSeat = targetKey;
                    if (isMovingIn) {
                        const tgtVac = getVac(targetKey);
                        const curVac = getVac(p.currentKey);
                        reason = `Awarded Pref #${pr.order}. Reduce ${targetKey} vacancy ${tgtVac} → ${tgtVac - 1}. Increase ${p.currentKey} vacancy ${curVac} → ${curVac + 1}.`;
                    } else {
                        reason = `Awarded Preference #${pr.order}. Remained in current position. ${getVac(p.currentKey)} vacancies available.`;
                    }
                    prefNum = pr.order;
                    awarded = true;
                    break;
                }
            }

            // ─── STEP B: Seniority Hold ──────────────────────────────────────
            // Holding your original base never needs a vacancy — you're already there.
            if (!awarded) {
                const cap = targetMap[p.orig] || 0;
                let rank = 1;
                for (const other of bidders) {
                    if (other.sen >= p.sen) break;
                    if (other.currentKey === p.orig) rank++;
                }
                const selfBid = p.prefs.find(pr => pr.targetKey === p.orig);
                const bplLimit = selfBid ? selfBid.bpl : 9999;

                if (rank <= bplLimit && rank <= cap) {
                    newSeat = p.orig;
                    reason = `Held Position (Seniority). ${getVac(p.orig)} vacancies available.`;
                    awarded = true;
                }
            }

            // ─── STEP C: Section 24 Secondary Displacement ──────────────────
            // Cascade fallback — still subject to vacancy gate.
            if (!awarded) {
                const cascadeOptions = [
                    ...['ANC', 'SEA', 'LAX', 'SAN', 'SFO', 'PDX', 'LAS']
                        .filter(b => b !== origBase)
                        .map(b => `${b}-${origStatus}`),
                    `${origBase}-FO`,
                    ...['ANC', 'SEA', 'LAX', 'SAN', 'SFO', 'PDX', 'LAS']
                        .filter(b => b !== origBase)
                        .map(b => `${b}-FO`)
                ];

                for (const targetKey of cascadeOptions) {
                    if (targetMap[targetKey] === undefined) continue;
                    const cap = targetMap[targetKey] || 0;
                    const isMovingIn = (p.currentKey !== targetKey);

                    let rank = 1;
                    for (const other of bidders) {
                        if (other.sen >= p.sen) break;
                        if (other.currentKey === targetKey) rank++;
                    }

                    // VACANCY GATE applies here too
                    const vacancyOk = isMovingIn ? getVac(targetKey) > 0 : true;

                    if (rank <= cap && vacancyOk) {
                        newSeat = targetKey;
                        const tgtVac = getVac(targetKey);
                        const curVac = getVac(p.currentKey);
                        reason = `Section 24: Awarded ${targetKey}. Reduce ${targetKey} vacancy ${tgtVac} → ${tgtVac - 1}. Increase ${p.currentKey} vacancy ${curVac} → ${curVac + 1}.`;
                        awarded = true;
                        break;
                    }
                }
            }

            // ─── STEP D: Pool (Unassigned) ───────────────────────────────────
            if (!awarded) {
                newSeat = "UNASSIGNED";
                let rank = 1;
                for (const other of bidders) {
                    if (other.sen >= p.sen) break;
                    if (other.currentKey === p.orig) rank++;
                }
                const selfBid = p.prefs.find(pr => pr.targetKey === p.orig);
                selfDisp = selfBid && rank > selfBid.bpl;

                const curVac = getVac(p.currentKey);
                const baseText = `Increase ${p.currentKey} vacancy ${curVac} → ${curVac + 1}.`;
                reason = selfDisp
                    ? `BPL Failure (Rank ${rank} > Limit ${selfBid.bpl}). ${baseText}`
                    : `Displaced: System-wide Reduction. ${baseText}`;
            }

            // ─── STATE UPDATE ────────────────────────────────────────────────
            p.awardedReason = reason;
            p.awardedPrefNum = prefNum;
            p.wasSelfDisplaced = selfDisp;

            if (newSeat !== p.currentKey) {
                if (p.currentKey !== "UNASSIGNED") currentCounts[p.currentKey]--;
                if (newSeat !== "UNASSIGNED") currentCounts[newSeat] = (currentCounts[newSeat] || 0) + 1;

                p.currentKey = newSeat;
                p.moved = (newSeat !== p.orig);
                p.isUnassigned = (newSeat === "UNASSIGNED");

                auditTrail.push({ loop: loops, sen: p.sen, name: p.name, to: newSeat, reason });

                // Restart cascade from pilot #1 — someone moved
                cascade = true;
                break;
            } else {
                p.moved = (p.currentKey !== p.orig);
                p.isUnassigned = (p.currentKey === "UNASSIGNED");
            }
        }

        if (loops > 10000) break; // Safety valve
    }

    return { roster: bidders, loops, auditTrail, targetMap };
}
