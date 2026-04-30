/**
 * AIRLINE BID ENGINE - Active-Only Rank Logic
 * 1. Physical Occupancy: Bidders + No-Bids occupy seats. Retired do not.
 * 2. Seniority Rank: Only Active Bidders more senior than the pilot are counted.
 * 3. BPL Check: Performed before "Remain in Position" to allow self-displacement.
 */
function runBidEngine(data, deltaMap, trackSen = null) {
    const auditTrail = [];
    const retiredSens = new Set(data.retired.map(p => p.seniority));
    const noBidSens = new Set(data.noBid.map(p => p.sen));

    // 1. Map No-Bid pilots to their fixed seats (Occupancy)
    const noBidOccupants = {};
    data.noBid.forEach(p => noBidOccupants[p.sen] = `${p.base}-${p.seat}`);

    // 2. Initialize Current Occupancy (Physical Seats)
    // Counts Bidders + No-Bids. Retired are excluded from the building.
    let currentCounts = {};
    data.caps.forEach(c => currentCounts[`${c.base}-${c.seat}`] = 0);

    // Initial count for No-Bids
    for (let sen in noBidOccupants) {
        const key = noBidOccupants[sen];
        if (currentCounts[key] === undefined) currentCounts[key] = 0;
        currentCounts[key]++;
    }

    // Initial count for Active Bidders
    const bidders = data.roster
        .filter(p => !retiredSens.has(p.sen) && !noBidSens.has(p.sen))
        .map(p => {
            const key = `${p.current.base}-${p.current.seat}`;
            if (currentCounts[key] === undefined) currentCounts[key] = 0;
            currentCounts[key]++;
            
            const prefData = data.prefs['pil' + p.sen] || data.prefs[p.id] || { preferences: [] };
            
            return {
                ...p, currentKey: key, orig: key, moved: false,
                prefHistory: {}, 
                prefs: (prefData.preferences || []).sort((a, b) => a.order - b.order)
            };
        }).sort((a, b) => a.sen - b.sen);

    // 3. Set Hard Targets (Initial Bidders + Initial No-Bids + Delta)
    let targetMap = {};
    for (let key in currentCounts) {
        targetMap[key] = currentCounts[key] + (deltaMap[key] || 0);
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
                
                // --- THE RANK CALCULATION (ACTIVE BIDDERS ONLY) ---
                // "BPL if awarded" only counts other ACTIVE bidders senior to 'p'
                let rank = 1;
                for (const other of bidders) {
                    if (other.sen >= p.sen) break; // Seniority limit reached
                    if (other.currentKey === targetKey) rank++;
                }

                // Note: No-Bid and Retired pilots are completely ignored in this rank check.

                // --- BPL CHECK ---
                const reqBPL = parseInt(pr.bpl_min) || 0;
                if (reqBPL > 0 && rank > reqBPL) {
                    p.prefHistory[pr.order] = { 
                        status: "Denied", 
                        reason: `Bid request does not meet BPL requirement. Requested BPL = ${reqBPL}. BPL if awarded = ${rank}.` 
                    };
                    continue; 
                }

                // --- REMAIN IN CURRENT POSITION ---
                if (targetKey === p.currentKey) {
                    p.prefHistory[pr.order] = { status: "Awarded", reason: "Remain in current position." };
                    break;
                }

                // --- CAPACITY CHECK ---
                const currentOcc = currentCounts[targetKey] || 0;
                const limit = targetMap[targetKey] || 0;
                const targetVacancies = limit - currentOcc;

                if (currentOcc < limit) {
                    const oldBase = p.currentKey;
                    const oldVacancies = (targetMap[oldBase] || 0) - (currentCounts[oldBase] || 0);

                    currentCounts[oldBase]--; 
                    currentCounts[targetKey]++;

                    p.prefHistory[pr.order] = { 
                        status: "Awarded", 
                        reason: `Open position available. Reduce vacancy in ${targetKey} from ${targetVacancies} to ${targetVacancies - 1}. Increase vacancy in ${oldBase} from ${oldVacancies} to ${oldVacancies + 1}.` 
                    };

                    auditTrail.push({
                        loop: loops, sen: p.sen, name: p.name, 
                        from: oldBase, fromTrans: `${oldVacancies} -> ${oldVacancies + 1}`,
                        to: targetKey, toTrans: `${targetVacancies} -> ${targetVacancies - 1}`
                    });
                    
                    p.currentKey = targetKey;
                    p.moved = true;
                    cascade = true; 
                    break; 
                } else {
                    p.prefHistory[pr.order] = { 
                        status: "Denied", 
                        reason: `Requested position has ${targetVacancies} vacancy and cannot accept additional pilots.` 
                    };
                }
            }
            if (cascade) break; 
        }
        if (loops > 10000) break;
    }
    return { roster: bidders, loops, auditTrail };
}
