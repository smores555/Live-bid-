/**
 * AIRLINE BID AUDIT ENGINE - REPLACEMENT LOGIC
 * Fixes: NaN initialization, SAN-CA Vacancy Tracking, and Audit Logs
 */
function runBidEngine(data, deltaMap, trackSen = null) {
    const auditTrail = [];
    const trace = [];
    
    const retiredSens = new Set(data.retired.map(p => p.seniority));
    const noBidSens = new Set(data.noBid.map(p => p.sen));

    // 1. Initialize ALL possible bases from the capacities file to 0
    let currentCounts = {};
    if (data.caps) {
        data.caps.forEach(c => {
            currentCounts[`${c.base}-${c.seat}`] = 0;
        });
    }

    // 2. Filter Bidders & Count Initial Occupancy (Active only)
    const bidders = data.roster
        .filter(p => !retiredSens.has(p.sen) && !noBidSens.has(p.sen))
        .map(p => {
            const key = `${p.current.base}-${p.current.seat}`;
            // Safety: Initialize if base wasn't in caps file
            if (currentCounts[key] === undefined) currentCounts[key] = 0;
            currentCounts[key]++;
            
            return {
                ...p, currentKey: key, orig: key, moved: false,
                prefs: (data.prefs[p.id]?.preferences || []).sort((a, b) => a.order - b.order)
            };
        }).sort((a, b) => a.sen - b.sen);

    // 3. Set Hard Targets (Initial Count + Delta)
    let targetMap = {};
    for (let key in currentCounts) {
        const delta = deltaMap[key] || 0;
        targetMap[key] = currentCounts[key] + delta;
    }
    // Ensure new bases like SAN are included even if initial active count was 0
    for (let key in deltaMap) {
        if (targetMap[key] === undefined) targetMap[key] = deltaMap[key];
    }

    let cascade = true;
    let loops = 0;

    // 4. Bidding Loop
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
                const limit = targetMap[targetKey] || 0;

                // Capacity Check
                if (currentOcc < limit) {
                    let rank = 1;
                    for (const other of bidders) {
                        if (other.currentKey === targetKey) rank++;
                    }
                    if (pr.bpl_min > 0 && rank > pr.bpl_min) continue;

                    // Log the Vacancy Transition
                    const oldBase = p.currentKey;
                    const oldVacBefore = (targetMap[oldBase] || 0) - currentCounts[oldBase];
                    const targetVacBefore = limit - currentOcc;

                    // Perform Move
                    currentCounts[oldBase]--; 
                    currentCounts[targetKey]++;

                    const oldVacAfter = (targetMap[oldBase] || 0) - currentCounts[oldBase];
                    const targetVacAfter = limit - currentCounts[targetKey];

                    auditTrail.push({
                        loop: loops,
                        sen: p.sen,
                        name: p.name,
                        from: oldBase,
                        fromTrans: `${oldVacBefore} to ${oldVacAfter}`,
                        to: targetKey,
                        toTrans: `${targetVacBefore} to ${targetVacAfter}`
                    });
                    
                    if (p.sen === trackSen) {
                        trace.push({type:'success', msg:`AWARDED ${targetKey}. Vacancy: ${targetVacBefore}->${targetVacAfter}`});
                    }
                    
                    p.currentKey = targetKey;
                    p.moved = true;
                    cascade = true; 
                    break; 
                }
            }
            if (cascade) break; 
        }
        if (loops > 10000) break; // Infinite loop safety
    }
    return { roster: bidders, loops, auditTrail, trace };
}
