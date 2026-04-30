/**
 * AIRLINE CASCADING BID ENGINE - Replacement Logic
 * - Force Match: Max Capacity = Initial Active Pilots + Delta.
 * - Ghost Pilots: Retired/No-Bid are ignored for capacity and seniority.
 * - Cascading: Restart from Pilot #1 on every successful award.
 */
function runBidEngine(data, deltaMap, trackSen = null) {
    const logs = [];
    const trace = [];
    
    // 1. Identify Ghost Pilots
    const retiredSens = new Set(data.retired.map(p => p.seniority));
    const noBidSens = new Set(data.noBid.map(p => p.sen));

    // 2. Initialize Counts & Force Match Max Capacity
    // We count only the active bidders currently in each seat.
    let currentCounts = {};
    const bidders = data.roster
        .filter(p => !retiredSens.has(p.sen) && !noBidSens.has(p.sen))
        .map(p => {
            const key = `${p.current.base}-${p.current.seat}`;
            currentCounts[key] = (currentCounts[key] || 0) + 1;
            return {
                ...p, currentKey: key, orig: key, moved: false,
                prefs: (data.prefs[p.id]?.preferences || []).sort((a, b) => a.order - b.order)
            };
        }).sort((a, b) => a.sen - b.sen);

    // Dynamic Capacity Calculation: Initial Active Pilots + Delta
    let maxCapMap = {};
    for (let key in currentCounts) {
        const delta = deltaMap[key] || 0;
        maxCapMap[key] = currentCounts[key] + delta;
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
                const targetKey = pr.bid.split(" ").slice(1).join("-");
                if (targetKey === p.currentKey) break;

                const currentOcc = currentCounts[targetKey] || 0;
                const maxCap = maxCapMap[targetKey] || 0;

                if (currentOcc < maxCap) {
                    // BPL Seniority Rank Check (Active Bidders only)
                    let rank = 1;
                    for (const other of bidders) {
                        if (other.currentKey === targetKey) rank++;
                    }

                    if (pr.bpl_min > 0 && rank > pr.bpl_min) {
                        if (p.sen === trackSen) trace.push({type:'fail', msg:`BPL REJECT: Rank ${rank} > Limit ${pr.bpl_min}`});
                        continue; 
                    }

                    // AWARD & RESTART
                    currentCounts[p.currentKey]--; // Vacancy created!
                    currentCounts[targetKey]++;    
                    logs.push({loop: loops, sen: p.sen, name: p.name, from: p.currentKey, to: targetKey});
                    
                    if (p.sen === trackSen) trace.push({type:'success', msg:`AWARDED ${targetKey} (Rank ${rank})`});
                    
                    p.currentKey = targetKey;
                    p.moved = true;
                    cascade = true; 
                    break; 
                } else if (p.sen === trackSen) {
                    trace.push({type:'fail', msg:`${targetKey} FULL (${currentOcc}/${maxCap})`});
                }
            }
            if (cascade) break; 
        }
    }
    return { roster: bidders, logs, trace, loops };
}
