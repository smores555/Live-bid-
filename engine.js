/**
 * AIRLINE DISPLACEMENT & TARGET-STATE ENGINE
 * Fixed: NaN initialization bug and SAN-CA overfill.
 */
function runBidEngine(data, deltaMap, trackSen = null) {
    const logs = [];
    const trace = [];
    
    const retiredSens = new Set(data.retired.map(p => p.seniority));
    const noBidSens = new Set(data.noBid.map(p => p.sen));

    // 1. Initialize ALL possible bases to 0 to prevent NaN
    let currentCounts = {};
    data.caps.forEach(c => {
        currentCounts[`${c.base}-${c.seat}`] = 0;
    });

    // 2. Count Active Bidders only
    const bidders = data.roster
        .filter(p => !retiredSens.has(p.sen) && !noBidSens.has(p.sen))
        .map(p => {
            const key = `${p.current.base}-${p.current.seat}`;
            // If a base isn't in caps, initialize it now
            if (currentCounts[key] === undefined) currentCounts[key] = 0;
            currentCounts[key]++;
            
            return {
                ...p, currentKey: key, orig: key, moved: false,
                prefs: (data.prefs[p.id]?.preferences || []).sort((a, b) => a.order - b.order)
            };
        }).sort((a, b) => a.sen - b.sen);

    // 3. Set Hard Targets (Initial + Delta)
    let targetMap = {};
    for (let key in currentCounts) {
        const delta = deltaMap[key] || 0;
        targetMap[key] = currentCounts[key] + delta;
    }
    // Ensure new bases like SAN are in the map even if initial count is 0
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
                
                if (targetKey === p.currentKey) break;

                const currentOcc = currentCounts[targetKey] || 0;
                const targetLimit = targetMap[targetKey] || 0;

                // STRICT CAPACITY CHECK
                if (currentOcc < targetLimit) {
                    let rank = 1;
                    for (const other of bidders) {
                        if (other.currentKey === targetKey) rank++;
                    }

                    if (pr.bpl_min > 0 && rank > pr.bpl_min) {
                        if (p.sen === trackSen) trace.push({type:'fail', msg:`BPL REJECT: ${targetKey} Rank ${rank} > ${pr.bpl_min}`});
                        continue; 
                    }

                    // AWARD & RESTART
                    currentCounts[p.currentKey]--; 
                    currentCounts[targetKey]++;    
                    
                    if (p.sen === trackSen) {
                        trace.push({type:'success', msg:`AWARDED ${targetKey} (Rank ${rank}). Base Size: ${currentCounts[targetKey]}/${targetLimit}`});
                    }
                    
                    p.currentKey = targetKey;
                    p.moved = true;
                    cascade = true; 
                    break; 
                } else if (p.sen === trackSen) {
                    trace.push({type:'fail', msg:`${targetKey} FULL (${currentOcc}/${targetLimit})`});
                }
            }
            if (cascade) break; 
        }
        if (loops > 10000) break;
    }
    return { roster: bidders, loops, trace };
}
