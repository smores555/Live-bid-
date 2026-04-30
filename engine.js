/**
 * AIRLINE BID ENGINE - With Preference Auditing
 */
function runBidEngine(data, deltaMap, trackSen = null) {
    const auditTrail = [];
    const retiredSens = new Set(data.retired.map(p => p.seniority));
    const noBidSens = new Set(data.noBid.map(p => p.sen));

    let currentCounts = {};
    data.caps.forEach(c => currentCounts[`${c.base}-${c.seat}`] = 0);

    const bidders = data.roster
        .filter(p => !retiredSens.has(p.sen) && !noBidSens.has(p.sen))
        .map(p => {
            const key = `${p.current.base}-${p.current.seat}`;
            if (currentCounts[key] === undefined) currentCounts[key] = 0;
            currentCounts[key]++;
            return {
                ...p, currentKey: key, orig: key, moved: false,
                prefHistory: {}, // STORES THE "WHY"
                prefs: (data.prefs[p.id]?.preferences || []).sort((a, b) => a.order - b.order)
            };
        }).sort((a, b) => a.sen - b.sen);

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
                
                if (targetKey === p.currentKey) {
                    p.prefHistory[pr.order] = { status: "Current", reason: "Pilot is currently in this position." };
                    break;
                }

                const currentOcc = currentCounts[targetKey] || 0;
                const limit = targetMap[targetKey] || 0;
                const vacancies = limit - currentOcc;

                // Check Capacity
                if (currentOcc < limit) {
                    // Check BPL
                    let rank = 1;
                    for (const other of bidders) {
                        if (other.currentKey === targetKey) rank++;
                    }

                    if (pr.bpl_min > 0 && rank > pr.bpl_min) {
                        p.prefHistory[pr.order] = { status: "Denied", reason: `BPL Fail: Rank ${rank} > Limit ${pr.bpl_min}` };
                        continue; 
                    }

                    // AWARD
                    const oldBase = p.currentKey;
                    currentCounts[oldBase]--; 
                    currentCounts[targetKey]++;

                    p.prefHistory[pr.order] = { status: "Awarded", reason: `Awarded in Loop ${loops}. Rank: ${rank}` };
                    
                    auditTrail.push({
                        loop: loops, sen: p.sen, name: p.name, from: oldBase, to: targetKey
                    });
                    
                    p.currentKey = targetKey;
                    p.moved = true;
                    cascade = true; 
                    break; 
                } else {
                    // DENIED REASON
                    p.prefHistory[pr.order] = { status: "Denied", reason: `Full: ${vacancies} vacancies available.` };
                }
            }
            if (cascade) break; 
        }
    }
    return { roster: bidders, loops, auditTrail };
}
