/**
 * AIRLINE BID AUDIT ENGINE
 * Tracks real-time vacancy transitions: "Base X: 0 -> 1 vacancies"
 */
function runBidEngine(data, deltaMap, trackSen = null) {
    const auditTrail = [];
    const trace = [];
    
    const retiredSens = new Set(data.retired.map(p => p.seniority));
    const noBidSens = new Set(data.noBid.map(p => p.sen));

    // 1. Initialize State
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
                prefs: (data.prefs[p.id]?.preferences || []).sort((a, b) => a.order - b.order)
            };
        }).sort((a, b) => a.sen - b.sen);

    // 2. Set Hard Targets & Initial Vacancy Math
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
                
                if (targetKey === p.currentKey) break;

                const currentOcc = currentCounts[targetKey] || 0;
                const limit = targetMap[targetKey] || 0;

                if (currentOcc < limit) {
                    let rank = 1;
                    for (const other of bidders) {
                        if (other.currentKey === targetKey) rank++;
                    }

                    if (pr.bpl_min > 0 && rank > pr.bpl_min) continue;

                    // --- THE AUDIT LOGIC ---
                    const oldBase = p.currentKey;
                    const oldVacanciesBefore = targetMap[oldBase] - currentCounts[oldBase];
                    const targetVacanciesBefore = limit - currentOcc;

                    // Perform Move
                    currentCounts[oldBase]--; 
                    currentCounts[targetKey]++;

                    const oldVacanciesAfter = targetMap[oldBase] - currentCounts[oldBase];
                    const targetVacanciesAfter = limit - currentCounts[targetKey];

                    auditTrail.push({
                        loop: loops,
                        sen: p.sen,
                        name: p.name,
                        action: 'MOVE',
                        from: oldBase,
                        fromVac: `${oldVacanciesBefore} -> ${oldVacanciesAfter}`,
                        to: targetKey,
                        toVac: `${targetVacanciesBefore} -> ${targetVacanciesAfter}`,
                        rank: rank
                    });
                    
                    if (p.sen === trackSen) {
                        trace.push({type:'success', msg:`AWARDED ${targetKey}. Vacancies: ${targetVacanciesBefore}->${targetVacanciesAfter}`});
                    }
                    
                    p.currentKey = targetKey;
                    p.moved = true;
                    cascade = true; 
                    break; 
                }
            }
            if (cascade) break; 
        }
        if (loops > 10000) break;
    }
    return { roster: bidders, loops, auditTrail, trace };
}
