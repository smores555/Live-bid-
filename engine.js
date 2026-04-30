/**
 * AIRLINE CASCADING BID ENGINE - Final Version
 * Logic: Max Capacity = (Initial Active Pilots) + (Delta)
 * Vacancies created whenever a pilot bids out.
 * Ghost Pilots (Retired/No-Bid) do not count toward initial occupancy or capacity.
 */
function runBidEngine(data, deltaMap, trackSen = null) {
    const logs = [];
    const trace = [];
    
    // 1. Identify Ghost Pilots
    const retiredSens = new Set(data.retired.map(p => p.seniority));
    const noBidSens = new Set(data.noBid.map(p => p.sen));

    // 2. Initialize Current Occupancy (Active Bidders Only)
    let currentCounts = {};
    const bidders = data.roster
        .filter(p => !retiredSens.has(p.sen) && !noBidSens.has(p.sen))
        .map(p => {
            const key = `${p.current.base}-${p.current.seat}`;
            currentCounts[key] = (currentCounts[key] || 0) + 1;
            return {
                ...p, 
                currentKey: key, 
                orig: key, 
                moved: false,
                prefs: (data.prefs[p.id]?.preferences || []).sort((a, b) => a.order - b.order)
            };
        }).sort((a, b) => a.sen - b.sen);

    // 3. Force Match Max Capacity: Initial Count + Input Delta
    let maxCapMap = {};
    for (let key in currentCounts) {
        const delta = deltaMap[key] || 0;
        maxCapMap[key] = currentCounts[key] + delta;
    }

    let cascade = true;
    let loops = 0;

    // 4. Cascading Bid Loop
    while (cascade) {
        cascade = false;
        loops++;
        for (let i = 0; i < bidders.length; i++) {
            const p = bidders[i];
            
            for (const pr of p.prefs) {
                if (!pr.bid) continue;
                const targetKey = pr.bid.split(" ").slice(1).join("-");
                if (targetKey === p.currentKey) break;

                const currentOcc = currentCounts[targetKey] || 0;
                const maxCap = maxCapMap[targetKey] || 0;

                // Check physical capacity (Initial + Delta)
                if (currentOcc < maxCap) {
                    
                    // BPL Seniority Rank Check (Active Bidders only)
                    let projectedRank = 1;
                    for (const other of bidders) {
                        if (other.currentKey === targetKey) projectedRank++;
                    }

                    if (pr.bpl_min > 0 && projectedRank > pr.bpl_min) {
                        if (p.sen === trackSen) {
                            trace.push({type:'fail', msg:`Pref ${pr.order}: BPL REJECT (Rank ${projectedRank} > Limit ${pr.bpl_min})`});
                        }
                        continue; 
                    }

                    // 5. Award and Vacate
                    currentCounts[p.currentKey]--; // This creates the vacancy for the next loop
                    currentCounts[targetKey]++;    
                    logs.push({loop: loops, sen: p.sen, name: p.name, from: p.currentKey, to: targetKey});
                    
                    if (p.sen === trackSen) {
                        trace.push({type:'success', msg:`Pref ${pr.order}: AWARDED ${targetKey} (Rank: ${projectedRank})`});
                    }
                    
                    p.currentKey = targetKey;
                    p.moved = true;
                    cascade = true; // Restart from Seniority #1
                    break; 
                } else if (p.sen === trackSen) {
                    trace.push({type:'fail', msg:`Pref ${pr.order}: ${targetKey} FULL (${currentOcc}/${maxCap})`});
                }
            }
            if (cascade) break; 
        }
        if (loops > 10000) break; // Infinite loop safety
    }
    return { roster: bidders, logs, trace, loops };
}
