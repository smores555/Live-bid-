/**
 * AIRLINE BID ENGINE - STRICT CAP + DETAILED TRACKER EDITION
 * * Features:
 * 1. Restarts from Seniority #1 on any move (True Cascade).
 * 2. STRICT CAP: Base capacity is an absolute hard limit.
 * 3. TRACKER: Explicitly logs vacancy increases/decreases during moves.
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

    // 2. Align Target Map & Initialize Vacancy Tracker
    let targetMap = {};
    let vacMap = {}; 
    Object.keys(liveHeadcount).forEach(key => {
        const delta = deltaMap[key] || 0;
        targetMap[key] = liveHeadcount[key] + delta;
        vacMap[key] = delta; // Vacancy starts exactly at the input Delta (e.g., +50 or -17)
    });
    data.caps.forEach(c => {
        const key = `${c.base}-${c.seat}`.toUpperCase();
        if (targetMap[key] === undefined) {
            targetMap[key] = c.startCapacity + (deltaMap[key] || 0);
            vacMap[key] = targetMap[key]; 
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
            let prefNum = "N/A";
            let method = "";
            let selfDisp = false;
            let moveRank = 1;
            const [origBase, origStatus] = p.orig.split('-');

            // Step A: Primary Preference Bids
            for (const pr of p.prefs) {
                if (!pr.targetKey) continue;
                let targetKey = pr.targetKey;
                let cap = targetMap[targetKey] || 0;

                let rank = 1;
                for (const other of bidders) {
                    if (other.sen >= p.sen) break;
                    if (other.currentKey === targetKey) rank++;
                }

                if (rank <= pr.bpl && rank <= cap) {
                    newSeat = targetKey;
                    prefNum = pr.order;
                    method = `Pref #${pr.order}`;
                    awarded = true;
                    break;
                }
            }

            // Step B: Seniority Hold
            if (!awarded) {
                let cap = targetMap[p.orig] || 0;
                let rank = 1;
                for (const other of bidders) {
                    if (other.sen >= p.sen) break;
                    if (other.currentKey === p.orig) rank++;
                }
                const selfBid = p.prefs.find(pr => pr.targetKey === p.orig);
                let bplLimit = selfBid ? selfBid.bpl : 9999;

                if (rank <= bplLimit && rank <= cap) {
                    newSeat = p.orig;
                    method = `Hold`;
                    awarded = true;
                }
            }

            // Step C: Section 24 Secondary Displacement
            if (!awarded) {
                const cascadeOptions = [...['ANC', 'SEA', 'LAX', 'SAN', 'SFO', 'PDX', 'LAS'].filter(b => b !== origBase).map(b => `${b}-${origStatus}`), `${origBase}-FO`, ...['ANC', 'SEA', 'LAX', 'SAN', 'SFO', 'PDX', 'LAS'].filter(b => b !== origBase).map(b => `${b}-FO`)];
                
                for (const targetKey of cascadeOptions) {
                    if (targetMap[targetKey] === undefined) continue;
                    let cap = targetMap[targetKey] || 0;
                    
                    let rank = 1;
                    for (const other of bidders) {
                        if (other.sen >= p.sen) break;
                        if (other.currentKey === targetKey) rank++;
                    }

                    if (rank <= cap) {
                        newSeat = targetKey;
                        method = `Section 24`;
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
                method = selfDisp ? `BPL Failure` : `Displaced`;
                moveRank = rank;
            }

            // --- STATE UPDATE & MATH TRACKER ---
            // We ONLY generate a new string if they physically change seats in this loop
            if (newSeat !== p.currentKey) {
                let oldVac = p.currentKey !== "UNASSIGNED" ? vacMap[p.currentKey] : 0;
                let newVac = newSeat !== "UNASSIGNED" ? vacMap[newSeat] : 0;

                // Adjust the live mathematical counts
                if (p.currentKey !== "UNASSIGNED") {
                    currentCounts[p.currentKey]--;
                    vacMap[p.currentKey]++;
                }
                if (newSeat !== "UNASSIGNED") {
                    currentCounts[newSeat]++;
                    vacMap[newSeat]--;
                }

                // Construct the highly specific Transition String
                let reasonStr = "";
                if (newSeat === "UNASSIGNED") {
                    let selfLog = selfDisp ? `(Rank ${moveRank} > Limit)` : ``;
                    reasonStr = `${method} ${selfLog}. Increase ${p.currentKey} vacancy ${oldVac} -> ${vacMap[p.currentKey]}.`;
                } else if (p.currentKey === "UNASSIGNED") {
                    reasonStr = `Awarded ${method}. Reduce ${newSeat} vacancy ${newVac} -> ${vacMap[newSeat]}.`;
                } else {
                    reasonStr = `Awarded ${method}. Reduce ${newSeat} vacancy ${newVac} -> ${vacMap[newSeat]}. Increase ${p.currentKey} vacancy ${oldVac} -> ${vacMap[p.currentKey]}.`;
                }

                // Apply changes
                p.currentKey = newSeat;
                p.awardedReason = reasonStr; // Locks in the string!
                p.awardedPrefNum = prefNum;
                p.moved = (newSeat !== p.orig);
                p.isUnassigned = (newSeat === "UNASSIGNED");
                p.wasSelfDisplaced = selfDisp;

                auditTrail.push({ loop: loops, sen: p.sen, name: p.name, to: newSeat, reason: reasonStr });

                // CRITICAL: Restart the process from Pilot #1 because a pilot moved
                cascade = true; 
                break;
            } else {
                // If they stayed put, just keep their background flags updated quietly
                p.awardedPrefNum = prefNum;
                p.wasSelfDisplaced = selfDisp;
            }
        }
        
        if (loops > 10000) break; // Safety breaker for infinite loops
    }

    // Post-Cascade Finalization for Non-Movers
    // Prints the final static vacancy count for pilots who held their seats
    bidders.forEach(p => {
        if (!p.moved && !p.isUnassigned) {
            if (p.awardedPrefNum !== "N/A") {
                p.awardedReason = `Awarded Preference #${p.awardedPrefNum}. Remained in current position. ${vacMap[p.orig]} vacancies available.`;
            } else {
                p.awardedReason = `Held Position (Seniority). ${vacMap[p.orig]} vacancies available.`;
            }
        }
    });

    return { roster: bidders, loops, auditTrail, targetMap };
}
