/**
 * AIRLINE BID ENGINE - CASCADE EDITION (Merged with Fallback Logic)
 * 
 * Features:
 * 1. Restarts from Seniority #1 on any move (True Cascade).
 * 2. Step A: Primary Bids & BPL.
 * 3. Step B: Seniority Hold.
 * 4. Step C: Section 24 Secondary Displacement.
 * 5. Step D: Unassigned Pool & Self-Displacement tracking.
 */
function runBidEngine(data, deltaMap) {
    const auditTrail = [];
    const is737 = (seat) => seat && !seat.includes('320') && !seat.includes('321');
    const retiredSens = new Set(data.retired.filter(p => is737(p.seat)).map(p => p.seniority));
    const noBidSens = new Set(data.noBid.filter(p => is737(p.seat)).map(p => p.sen));
    const activeBidders = data.roster.filter(p => is737(p.current.seat) && !retiredSens.has(p.sen) && !noBidSens.has(p.sen));

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

    // 3. Initialize "Desks Full" counts
    let currentCounts = { ...liveHeadcount };

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

    // 5. The Seniority Cascade with Fallbacks
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

            // Step A: Primary Preference Bids
            for (const pr of p.prefs) {
                if (!pr.targetKey) continue;
                let targetKey = pr.targetKey;
                let cap = targetMap[targetKey] || 0;

                // Calculate Rank (only counting pilots senior to p currently in this seat)
                let rank = 1;
                for (const other of bidders) {
                    if (other.sen >= p.sen) break;
                    if (other.currentKey === targetKey) rank++;
                }

                if (rank <= pr.bpl) {
                    // Check physical capacity. (If they already hold this seat in the loop, they don't need a new vacancy)
                    if (p.currentKey === targetKey || (currentCounts[targetKey] || 0) < cap) {
                        newSeat = targetKey;
                        reason = (p.orig !== targetKey) ? `Awarded Pref #${pr.order} via Vacancy.` : `Awarded Preference #${pr.order}. Remained in current position.`;
                        prefNum = pr.order;
                        awarded = true;
                        break;
                    }
                }
            }

            // Step B: Seniority Hold
            if (!awarded) {
                let rank = 1;
                for (const other of bidders) {
                    if (other.sen >= p.sen) break;
                    if (other.currentKey === p.orig) rank++;
                }
                const selfBid = p.prefs.find(pr => pr.targetKey === p.orig);
                let bplLimit = selfBid ? selfBid.bpl : 9999;

                if (rank <= bplLimit && (p.currentKey === p.orig || (currentCounts[p.orig] || 0) < (targetMap[p.orig] || 0))) {
                    newSeat = p.orig;
                    reason = `Held Position (Seniority).`;
                    awarded = true;
                }
            }

            // Step C: Section 24 Secondary Displacement
            if (!awarded) {
                const cascadeOptions = [...['ANC', 'SEA', 'LAX', 'SAN', 'SFO', 'PDX', 'LAS'].filter(b => b !== origBase).map(b => `${b}-${origStatus}`), `${origBase}-FO`, ...['ANC', 'SEA', 'LAX', 'SAN', 'SFO', 'PDX', 'LAS'].filter(b => b !== origBase).map(b => `${b}-FO`)];
                for (const targetKey of cascadeOptions) {
                    if (targetMap[targetKey] === undefined) continue;
                    let cap = targetMap[targetKey] || 0;
                    
                    if (p.currentKey === targetKey || (currentCounts[targetKey] || 0) < cap) {
                        newSeat = targetKey;
                        reason = `Section 24: Awarded ${targetKey} (Vacancy).`;
                        awarded = true;
                        break;
                    }
                }
            }

            // Step D: Pool (Unassigned)
            if (!awarded) {
                newSeat = "UNASSIGNED";
                let rank = 1;
                for (const other of bidders) {
                    if (other.sen >= p.sen) break;
                    if (other.currentKey === p.orig) rank++;
                }
                const selfBid = p.prefs.find(pr => pr.targetKey === p.orig);
                selfDisp = selfBid && rank > selfBid.bpl;
                reason = selfDisp ? `BPL Failure (Rank ${rank} > Limit ${selfBid.bpl}).` : `Displaced: System-wide Reduction.`;
            }

            // If the best valid seat for this pilot is different from where they currently sit in the loop, execute the move.
            if (newSeat !== p.currentKey) {
                // Adjust global seat counts
                if (p.currentKey !== "UNASSIGNED") currentCounts[p.currentKey]--;
                if (newSeat !== "UNASSIGNED") currentCounts[newSeat] = (currentCounts[newSeat] || 0) + 1;

                // Update Pilot State
                p.currentKey = newSeat;
                p.awardedReason = reason;
                p.awardedPrefNum = prefNum;
                p.moved = (newSeat !== p.orig);
                p.isUnassigned = (newSeat === "UNASSIGNED");
                p.wasSelfDisplaced = selfDisp;

                auditTrail.push({ loop: loops, sen: p.sen, name: p.name, to: newSeat, reason: reason });

                // CRITICAL: Restart the process from Pilot #1 because a pilot moved
                cascade = true; 
                break;
            }
        }
        
        if (loops > 10000) break; // Safety breaker for infinite loops
    }

    return { roster: bidders, loops, auditTrail, targetMap };
}
