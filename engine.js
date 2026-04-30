/**
 * AIRLINE BID ENGINE - Exact Company Validation Logging
 * Fixes: Deduplication, undefined vacancies, exact string matching.
 */
function runBidEngine(data, deltaMap, trackSen = null) {
    const auditTrail = [];
    
    const retiredSens = new Set(data.retired.map(p => p.seniority));
    const noBidSens = new Set(data.noBid.map(p => p.sen));

    // 1. STRICT DEDUPLICATION
    // Ensures each pilot only exists once, even if roster data has duplicates
    const rosterMap = new Map();
    data.roster.forEach(p => {
        if (!rosterMap.has(p.sen)) rosterMap.set(p.sen, p);
    });

    let currentCounts = {};
    if (data.caps) {
        data.caps.forEach(c => currentCounts[`${c.base}-${c.seat}`] = 0);
    }

    // 2. Initialize Active Bidders
    const bidders = Array.from(rosterMap.values())
        .filter(p => !retiredSens.has(p.sen) && !noBidSens.has(p.sen))
        .map(p => {
            const key = `${p.current.base}-${p.current.seat}`;
            if (currentCounts[key] === undefined) currentCounts[key] = 0;
            currentCounts[key]++;
            
            return {
                ...p, currentKey: key, orig: key, moved: false,
                prefHistory: {}, // Stores the exact company reason
                prefs: (data.prefs[p.id]?.preferences || []).sort((a, b) => a.order - b.order)
            };
        }).sort((a, b) => a.sen - b.sen);

    // 3. Set Hard Targets
    let targetMap = {};
    for (let key in currentCounts) {
        targetMap[key] = currentCounts[key] + (deltaMap[key] || 0);
    }
    for (let key in deltaMap) {
        if (targetMap[key] === undefined) targetMap[key] = deltaMap[key];
    }

    let cascade = true;
    let loops = 0;

    // 4. Cascade Engine
    while (cascade) {
        cascade = false;
        loops++;
        for (let i = 0; i < bidders.length; i++) {
            const p = bidders[i];
            
            for (const pr of p.prefs) {
                if (!pr.bid) continue;
                const parts = pr.bid.trim().split(/\s+/);
                if (parts.length < 3) continue;
                const targetKey = `${parts[1]}-${parts[2]}`;
                
                // EXACT STRING: Remain in current position
                if (targetKey === p.currentKey) {
                    p.prefHistory[pr.order] = { status: "Awarded", reason: "Remain in current position." };
                    break;
                }

                const currentOcc = currentCounts[targetKey] || 0;
                const limit = targetMap[targetKey] || 0;
                const targetVacancies = limit - currentOcc;

                // Capacity Check
                if (currentOcc < limit) {
                    let rank = 1;
                    for (const other of bidders) {
                        if (other.currentKey === targetKey) rank++;
                    }

                    // EXACT STRING: BPL Fail
                    if (pr.bpl_min > 0 && rank > pr.bpl_min) {
                        p.prefHistory[pr.order] = { 
                            status: "Denied", 
                            reason: `Bid request does not meet BPL requirement. Requested BPL = ${pr.bpl_min}. BPL if awarded = ${rank}.` 
                        };
                        continue; 
                    }

                    // Perform Move
                    const oldBase = p.currentKey;
                    const oldOcc = currentCounts[oldBase] || 0;
                    const oldLimit = targetMap[oldBase] || 0;
                    const oldVacancies = oldLimit - oldOcc;

                    currentCounts[oldBase]--; 
                    currentCounts[targetKey]++;

                    // EXACT STRING: Awarded with vacancy math
                    p.prefHistory[pr.order] = { 
                        status: "Awarded", 
                        reason: `Open position available. Reduce vacancy in ${targetKey} from ${targetVacancies} to ${targetVacancies - 1}. Increase vacancy in ${oldBase} from ${oldVacancies} to ${oldVacancies + 1}.` 
                    };

                    auditTrail.push({
                        loop: loops, sen: p.sen, name: p.name, 
                        from: oldBase, fromTrans: `${oldVacancies} -> ${oldVacancies + 1}`,
                        to: targetKey, toTrans: `${targetVacancies} -> ${targetVacancies - 1}`
                    });
                    
                    p.currentKey = targetKey;
                    p.moved = true;
                    cascade = true; 
                    break; 
                } else {
                    // EXACT STRING: Capacity Fail
                    p.prefHistory[pr.order] = { 
                        status: "Denied", 
                        reason: `Requested position has ${targetVacancies} vacancy and cannot accept additional pilots.` 
                    };
                }
            }
            if (cascade) break; 
        }
        if (loops > 10000) break;
    }
    return { roster: bidders, loops, auditTrail };
}
