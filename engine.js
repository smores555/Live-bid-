/**
 * AIRLINE DISPLACEMENT & TARGET-STATE ENGINE
 * 1. Ghost Pilots: Filtered out before setup; do not count toward Target or Rank.
 * 2. Hard Target: Target Cap = (Initial Active Pilots) + (Delta).
 * 3. Displacement: Entry only allowed if Current Active Count < Target Cap.
 * 4. Cascade: Restart from Pilot #1 on every successful award.
 */
function runBidEngine(data, deltaMap, trackSen = null) {
    const logs = [];
    const trace = [];
    
    // 1. Identify Ghost Pilots (Retired/No-Bid)
    const retiredSens = new Set(data.retired.map(p => p.seniority));
    const noBidSens = new Set(data.noBid.map(p => p.sen));

    // 2. Initialize Current Counts (Active Bidders ONLY)
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

    // 3. SET THE HARD TARGET BUDGET
    // Formula: Initial Active Bidders + Input Delta
    let targetMap = {};
    for (let key in deltaMap) {
        const initialActive = currentCounts[key] || 0;
        const delta = deltaMap[key] || 0;
        targetMap[key] = initialActive + delta; 
    }

    let cascade = true;
    let loops = 0;

    // 4. Cascading Seniority Draft
    while (cascade) {
        cascade = false;
        loops++;
        for (let i = 0; i < bidders.length; i++) {
            const p = bidders[i];
            
            for (const pr of p.prefs) {
                if (!pr.bid) continue;
                
                // Parse "1 SAN CA" -> "SAN-CA"
                const parts = pr.bid.trim().split(/\s+/);
                if (parts.length < 3) continue;
                const targetKey = `${parts[1]}-${parts[2]}`;
                
                if (targetKey === p.currentKey) break;

                const currentOcc = currentCounts[targetKey] || 0;
                const targetLimit = targetMap[targetKey] || 0;

                // ENTRY RULE: Only if below the Hard Target
                if (currentOcc < targetLimit) {
                    
                    // BPL Rank Check (Active Bidders in target base + 1)
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

                    // AWARD & RESTART
                    currentCounts[p.currentKey]--; // Vacate old seat
                    currentCounts[targetKey]++;    // Occupy new seat
                    
                    logs.push({loop: loops, sen: p.sen, name: p.name, from: p.currentKey, to: targetKey});
                    
                    if (p.sen === trackSen) {
                        trace.push({type:'success', msg:`AWARDED ${targetKey} (Rank ${projectedRank}). Target Budget: ${currentCounts[targetKey]}/${targetLimit}`});
                    }
                    
                    p.currentKey = targetKey;
                    p.moved = true;
                    cascade = true; // Signal to restart from Pilot #1
                    break; 
                } else if (p.sen === trackSen) {
                    trace.push({type:'fail', msg:`Pref ${pr.order}: ${targetKey} FULL/DISPLACING (${currentOcc} >= ${targetLimit})`});
                }
            }
            if (cascade) break; // Break pilot loop to restart whole bid
        }
        if (loops > 10000) break; // Safety
    }
    return { roster: bidders, logs, trace, loops };
}
