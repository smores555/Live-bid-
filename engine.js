/**
 * AIRLINE DISPLACEMENT & TARGET-STATE ENGINE
 * 1. Dedup: Ensures each pilot is processed only once.
 * 2. Ghost Pilots: Filtered out; do not count toward Target Budget or Rank.
 * 3. Hard Target: Target Budget = (Initial Active Pilots) + (Delta).
 * 4. Displacement: Entry only allowed if Current Active Count < Target Budget.
 * 5. Cascade: Restart from Pilot #1 on every successful award.
 */
function runBidEngine(data, deltaMap, trackSen = null) {
    const logs = [];
    const trace = [];
    
    const retiredSens = new Set(data.retired.map(p => p.seniority));
    const noBidSens = new Set(data.noBid.map(p => p.sen));

    // Deduplicate Roster to ensure count accuracy
    const uniqueRoster = [];
    const seenSens = new Set();
    data.roster.forEach(p => {
        if (!seenSens.has(p.sen)) {
            uniqueRoster.push(p);
            seenSens.add(p.sen);
        }
    });

    // 1. Initialize Current Occupancy (Active Bidders ONLY)
    let currentCounts = {};
    const bidders = uniqueRoster
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

    // 2. SET THE HARD TARGET BUDGET
    // Logic: Initial Active Count + Delta = Max Allowable Active Pilots
    let targetMap = {};
    // Ensure all bases from capacities are initialized
    data.caps.forEach(c => {
        const key = `${c.base}-${c.seat}`;
        const initialActive = currentCounts[key] || 0;
        const delta = deltaMap[key] || 0;
        targetMap[key] = initialActive + delta;
    });

    if (trackSen) {
        trace.push({type:'info', msg: `DEBUG: SAN-CA Target Budget set to ${targetMap['SAN-CA'] || 'N/A'}`});
    }

    let cascade = true;
    let loops = 0;

    // 3. The Cascading Seniority Draft
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

                // 4. THE CAPACITY CHECK
                // Only award if current count is strictly less than the Hard Target
                if (currentOcc < targetLimit) {
                    
                    // BPL Rank Check
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

                    // 5. AWARD, VACATE, & RESTART
                    currentCounts[p.currentKey]--; // Old seat vacated
                    currentCounts[targetKey]++;    // New seat filled
                    
                    logs.push({loop: loops, sen: p.sen, name: p.name, from: p.currentKey, to: targetKey});
                    
                    if (p.sen === trackSen) {
                        trace.push({type:'success', msg:`AWARDED ${targetKey}. Base Size: ${currentCounts[targetKey]}/${targetLimit}`});
                    }
                    
                    p.currentKey = targetKey;
                    p.moved = true;
                    cascade = true; // RESTART FROM PILOT #1
                    break; 
                } else if (p.sen === trackSen) {
                    trace.push({type:'fail', msg:`Pref ${pr.order}: ${targetKey} FULL/DISPLACING (${currentOcc} occupants >= ${targetLimit} target)`});
                }
            }
            if (cascade) break; 
        }
        if (loops > 10000) break; 
    }
    return { roster: bidders, logs, trace, loops };
}
