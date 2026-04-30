/**
 * AIRLINE CASCADING BID ENGINE
 * 1. Ghost Pilots: Retired/No-Bid are invisible to capacity/rank math.
 * 2. Force Match: Max Capacity = (Active Pilots in Base) + (Input Delta).
 * 3. BPL Check: Rank among active bidders must be <= BPL limit.
 * 4. Cascade: Restart from Pilot #1 on every successful award.
 */
function runBidEngine(data, deltaMap, trackSen = null) {
    const logs = [];
    const trace = [];
    
    const retiredSens = new Set(data.retired.map(p => p.seniority));
    const noBidSens = new Set(data.noBid.map(p => p.sen));

    // Initialize Counts (Active Bidders only)
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

    // Initialize Max Capacity for ALL bases (including new bases like SAN)
    let maxCapMap = {};
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
                
                const parts = pr.bid.trim().split(/\s+/);
                if (parts.length < 3) continue; // Skip bad bid strings
                const targetKey = `${parts[1]}-${parts[2]}`;
                
                if (targetKey === p.currentKey) break;

                const currentOcc = currentCounts[targetKey] || 0;
                const maxCap = maxCapMap[targetKey] || 0;

                if (currentOcc < maxCap) {
                    // BPL Rank Check
                    let rank = 1;
                    for (const other of bidders) {
                        if (other.currentKey === targetKey) rank++;
                    }

                    if (pr.bpl_min > 0 && rank > pr.bpl_min) {
                        if (p.sen === trackSen) trace.push({type:'fail', msg:`BPL REJECT: ${targetKey} Rank ${rank} > ${pr.bpl_min}`});
                        continue; 
                    }

                    // AWARD & RESTART
                    currentCounts[p.currentKey]--; // Old seat vacated
                    currentCounts[targetKey]++;    // New seat filled
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
