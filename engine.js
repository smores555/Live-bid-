/**
 * AIRLINE CASCADING BID ENGINE - New Base Fix
 * Logic: Max Capacity = (Active Pilots in Base) + (Input Delta)
 * If Active Count is 0 (New Base), Max Capacity = Delta.
 */
function runBidEngine(data, deltaMap, trackSen = null) {
    const logs = [];
    const trace = [];
    
    const retiredSens = new Set(data.retired.map(p => p.seniority));
    const noBidSens = new Set(data.noBid.map(p => p.sen));

    // 1. Count only active bidders currently in each seat
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

    // 2. FIXED: Initialize Max Capacity for ALL bases, including new ones like SAN
    let maxCapMap = {};
    // Use the deltas provided by the UI to define the possible bases
    for (let key in deltaMap) {
        const initialCount = currentCounts[key] || 0;
        const delta = deltaMap[key] || 0;
        maxCapMap[key] = initialCount + delta;
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

                // 3. Physical Capacity Check
                if (currentOcc < maxCap) {
                    let rank = 1;
                    for (const other of bidders) {
                        if (other.currentKey === targetKey) rank++;
                    }

                    // BPL Check
                    if (pr.bpl_min > 0 && rank > pr.bpl_min) {
                        if (p.sen === trackSen) trace.push({type:'fail', msg:`BPL REJECT: ${targetKey} Rank ${rank} > Limit ${pr.bpl_min}`});
                        continue; 
                    }

                    // AWARD & RESTART
                    currentCounts[p.currentKey]--; 
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
