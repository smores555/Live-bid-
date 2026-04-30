function runBidEngine(data, capacities, trackSen = null) {
    const logs = [];
    const trace = [];
    
    const retiredSens = new Set(data.retired.map(p => p.seniority));
    const noBidSens = new Set(data.noBid.map(p => p.sen));

    // GHOST LOGIC: We only count active bidders. 
    // Retired/No-Bids are ignored for capacity and seniority rank.
    let counts = {};
    const bidders = data.roster
        .filter(p => !retiredSens.has(p.sen) && !noBidSens.has(p.sen))
        .map(p => {
            const key = `${p.current.base}-${p.current.seat}`;
            counts[key] = (counts[key] || 0) + 1;
            return {
                ...p, currentKey: key, orig: key, moved: false,
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
                    // BPL Logic: Rank among ACTIVE bidders only
                    let projectedRank = 1;
                    for (const other of bidders) {
                        if (other.currentKey === targetKey) projectedRank++;
                    }

                    if (pr.bpl_min > 0 && projectedRank > pr.bpl_min) {
                        if (p.sen === trackSen) trace.push({type:'fail', msg:`BPL REJECT: Rank ${projectedRank} > ${pr.bpl_min}`});
                        continue; 
                    }

                    // AWARD & RESTART
                    counts[p.currentKey]--; 
                    counts[targetKey]++;    
                    logs.push({loop: loops, sen: p.sen, name: p.name, from: p.currentKey, to: targetKey});
                    
                    if (p.sen === trackSen) trace.push({type:'success', msg:`AWARDED ${targetKey} (Rank ${projectedRank})`});
                    
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
