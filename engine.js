/**
 * AIRLINE CASCADING BID ENGINE
 * - Ghost Pilots: Retired/No-Bid are ignored by capacity and bidding.
 * - BPL Logic: Must be Rank X or lower (more senior) to be awarded.
 * - Cascading: Restart from Pilot #1 on every award.
 */
function runBidEngine(data, capacities, trackSen = null) {
    const logs = [];
    const trace = [];
    
    // 1. Identify Ghost Pilots
    const retiredSens = new Set(data.retired.map(p => p.seniority));
    const noBidSens = new Set(data.noBid.map(p => p.sen));

    // 2. Initialize Active Bidders only
    // Ghost pilots are filtered out; they do not count against capacity or vacancies.
    let counts = {};
    const bidders = data.roster
        .filter(p => !retiredSens.has(p.sen) && !noBidSens.has(p.sen))
        .map(p => {
            const key = `${p.current.base}-${p.current.seat}`;
            counts[key] = (counts[key] || 0) + 1;
            return {
                ...p, 
                currentKey: key, 
                orig: key, 
                moved: false,
                prefs: (data.prefs[p.id]?.preferences || []).sort((a, b) => a.order - b.order)
            };
        }).sort((a, b) => a.sen - b.sen);

    let cascade = true;
    let loops = 0;

    while (cascade) {
        cascade = false;
        loops++;
        for (let i = 0; i < bidders.length; i++) {
            const p = bidders[i];
            
            for (const pr of p.prefs) {
                if (!pr.bid) continue;
                const targetKey = pr.bid.split(" ").slice(1).join("-");
                if (targetKey === p.currentKey) break;

                const currentOcc = counts[targetKey] || 0;
                const maxCap = capacities[targetKey] || 0;

                if (currentOcc < maxCap) {
                    // 3. BPL Rank Check
                    // Rank is determined only by Active Bidders in that position.
                    let projectedRank = 1;
                    for (const other of bidders) {
                        if (other.currentKey === targetKey) projectedRank++;
                    }

                    // BPL Logic: Awarded if rank <= bpl_min (more senior or equal)
                    if (pr.bpl_min > 0 && projectedRank > pr.bpl_min) {
                        if (p.sen === trackSen) {
                            trace.push({type:'fail', msg:`Pref ${pr.order} (${targetKey}): BPL REJECT (Rank ${projectedRank} > Limit ${pr.bpl_min})`});
                        }
                        continue; 
                    }

                    // 4. Award & Cascading Restart
                    counts[p.currentKey]--; 
                    counts[targetKey]++;    
                    logs.push({loop: loops, sen: p.sen, name: p.name, from: p.currentKey, to: targetKey});
                    
                    if (p.sen === trackSen) {
                        trace.push({type:'success', msg:`Pref ${pr.order} (${targetKey}): AWARDED! (Rank: ${projectedRank})`});
                    }
                    
                    p.currentKey = targetKey;
                    p.moved = true;
                    cascade = true; // Restart from Seniority #1
                    break; 
                } else if (p.sen === trackSen) {
                    trace.push({type:'fail', msg:`Pref ${pr.order} (${targetKey}): Full (${currentOcc}/${maxCap})`});
                }
            }
            if (cascade) break; 
        }
        if (loops > 10000) break; 
    }
    return { roster: bidders, logs, trace, loops };
}
