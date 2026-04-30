/**
 * AIRLINE BID ENGINE - Self-Displacement Fix
 * Calculates Rank and BPL for EVERY preference, allowing pilots to 
 * "force themselves out" of their current base if they fail their own BPL.
 */
function runBidEngine(data, deltaMap, trackSen = null) {
    const auditTrail = [];
    
    const retiredSens = new Set(data.retired.map(p => p.seniority));
    const noBidSens = new Set(data.noBid.map(p => p.sen));

    // Deduplicate Roster
    const rosterMap = new Map();
    data.roster.forEach(p => {
        if (!rosterMap.has(p.sen)) rosterMap.set(p.sen, p);
    });

    let currentCounts = {};
    if (data.caps) {
        data.caps.forEach(c => currentCounts[`${c.base}-${c.seat}`] = 0);
    }

    const bidders = Array.from(rosterMap.values())
        .filter(p => !retiredSens.has(p.sen) && !noBidSens.has(p.sen))
        .map(p => {
            const key = `${p.current.base}-${p.current.seat}`;
            if (currentCounts[key] === undefined) currentCounts[key] = 0;
            currentCounts[key]++;
            
            return {
                ...p, currentKey: key, orig: key, moved: false,
                prefHistory: {}, 
                prefs: (data.prefs[p.id]?.preferences || []).sort((a, b) => a.order - b.order)
            };
        }).sort((a, b) => a.sen - b.sen);

    // Set Hard Targets
    let targetMap = {};
    for (let key in currentCounts) {
        targetMap[key] = currentCounts[key] + (deltaMap[key] || 0);
    }
    for (let key in deltaMap) {
        if (targetMap[key] === undefined) targetMap[key] = deltaMap[key];
    }

    let cascade = true;
    let loops = 0;

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
                
                // 1. CALCULATE RANK FIRST (Must happen for all prefs, even current base)
                let rank = 1;
                for (const other of bidders) {
                    if (other.currentKey === targetKey) rank++;
                }

                // 2. CHECK BPL FIRST
                // This allows a pilot to force themselves out of their current position
                if (pr.bpl_min > 0 && rank > pr.bpl_min) {
                    p.prefHistory[pr.order] = { 
                        status: "Denied", 
                        reason: `Bid request does not meet BPL requirement. Requested BPL = ${pr.bpl_min}. BPL if awarded = ${rank}.` 
                    };
                    continue; // Failed BPL, keep reading down the preference list
                }

                // 3. REMAIN IN CURRENT POSITION (If BPL Passes)
                if (targetKey === p.currentKey) {
                    p.prefHistory[pr.order] = { status: "Awarded", reason: "Remain in current position." };
                    break;
                }

                // 4. NEW POSITION CAPACITY CHECK
                const currentOcc = currentCounts[targetKey] || 0;
                const limit = targetMap[targetKey] || 0;
                const targetVacancies = limit - currentOcc;

                if (currentOcc < limit) {
                    const oldBase = p.currentKey;
                    const oldOcc = currentCounts[oldBase] || 0;
                    const oldLimit = targetMap[oldBase] || 0;
                    const oldVacancies = oldLimit - oldOcc;

                    currentCounts[oldBase]--; 
                    currentCounts[targetKey]++;

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
