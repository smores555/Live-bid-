/**
 * AIRLINE BID ENGINE - DISPLACEMENT & BUMPING EDITION
 * 1. Vacancy First: Always tries to fill a natural vacancy first.
 * 2. Bumping Fallback: If displaced and no vacancy exists, the pilot can 
 * "force out" the most junior pilot in their preferred base/seat.
 * 3. Cascade: Every bump triggers a full restart from Seniority #1.
 */
function runBidEngine(data, deltaMap) {
    const auditTrail = [];
    const is737 = (seat) => seat && !seat.includes('320') && !seat.includes('321');

    const retiredSens = new Set(data.retired.filter(p => is737(p.seat)).map(p => p.seniority));
    const noBid737 = data.noBid.filter(p => is737(p.seat));
    const noBidSens = new Set(noBid737.map(p => p.sen));

    const noBidOccupancy = {};
    noBid737.forEach(p => noBidOccupancy[p.sen] = `${p.base}-${p.seat}`);

    let currentCounts = {};
    data.caps.forEach(c => currentCounts[`${c.base}-${c.seat}`] = 0);

    for (let sen in noBidOccupancy) {
        const key = noBidOccupancy[sen];
        currentCounts[key] = (currentCounts[key] || 0) + 1;
    }

    const rosterMap = new Map();
    data.roster.forEach(p => {
        if (!rosterMap.has(p.sen) && is737(p.current.seat)) rosterMap.set(p.sen, p);
    });

    const bidders = Array.from(rosterMap.values())
        .filter(p => !retiredSens.has(p.sen) && !noBidSens.has(p.sen))
        .map(p => {
            const key = `${p.current.base}-${p.current.seat}`;
            currentCounts[key] = (currentCounts[key] || 0) + 1;
            const prefData = data.prefs['pil' + p.sen] || data.prefs[p.id] || { preferences: [] };
            return {
                ...p, currentKey: key, orig: key, moved: false, isDisplaced: false,
                prefHistory: {}, 
                prefs: (prefData.preferences || []).sort((a, b) => a.order - b.order)
            };
        }).sort((a, b) => a.sen - b.sen);

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
            let foundAward = false;

            for (const pr of p.prefs) {
                if (!pr.bid) continue;
                const parts = pr.bid.trim().split(/\s+/);
                if (parts.length < 3) continue;
                const targetKey = `${parts[1]}-${parts[2]}`;
                
                // --- RANK CALCULATION ---
                let rank = 1;
                for (const other of bidders) {
                    if (other.sen >= p.sen) break;
                    if (other.currentKey === targetKey) rank++;
                }

                const reqBPL = parseInt(pr.bpl_min) || 0;
                const bplLog = `. BPL if awarded: ${rank}.`;

                // BPL GATE
                if (reqBPL > 0 && rank > reqBPL) {
                    p.prefHistory[pr.order] = { status: "Denied", reason: `BPL Fail. Limit ${reqBPL}${bplLog}` };
                    continue; 
                }

                const currentOcc = currentCounts[targetKey] || 0;
                const limit = targetMap[targetKey] || 0;

                // --- 1. REMAIN IN POSITION CHECK ---
                if (targetKey === p.currentKey) {
                    if (currentOcc > limit) {
                        p.prefHistory[pr.order] = { status: "Denied", reason: `DISPLACED: Base over capacity (${currentOcc}/${limit}).` };
                        p.isDisplaced = true;
                        continue; // Forced to look at next preference
                    } else {
                        p.prefHistory[pr.order] = { status: "Awarded", reason: `Remain in current position${bplLog}` };
                        foundAward = true;
                        break;
                    }
                }

                // --- 2. VACANCY AWARD ---
                if (currentOcc < limit) {
                    const oldKey = p.currentKey;
                    currentCounts[oldKey]--; 
                    currentCounts[targetKey]++;
                    
                    p.prefHistory[pr.order] = { status: "Awarded", reason: `Awarded via Vacancy${bplLog}` };
                    auditTrail.push({ loop: loops, sen: p.sen, name: p.name, from: oldKey, to: targetKey, type: "Vacancy" });
                    
                    p.currentKey = targetKey;
                    p.moved = true;
                    p.isDisplaced = false;
                    cascade = true;
                    foundAward = true;
                    break;
                }

                // --- 3. BUMPING LOGIC (The "Junior Man" Force Out) ---
                // Find the most junior pilot (highest sen number) currently in that base
                let juniorMan = null;
                for (let j = bidders.length - 1; j >= 0; j--) {
                    const potential = bidders[j];
                    if (potential.currentKey === targetKey) {
                        juniorMan = potential;
                        break;
                    }
                }

                // If the current bidder is senior (lower number) than the Junior Man
                if (juniorMan && p.sen < juniorMan.sen) {
                    const oldKey = p.currentKey;
                    
                    // The switch happens
                    currentCounts[oldKey]--;
                    // Occupancy in targetKey stays the same (one in, one out)
                    
                    p.prefHistory[pr.order] = { 
                        status: "Awarded", 
                        reason: `BUMPED Junior Man #${juniorMan.sen} (${juniorMan.name})${bplLog}` 
                    };

                    auditTrail.push({ 
                        loop: loops, sen: p.sen, name: p.name, 
                        from: oldKey, to: targetKey, 
                        type: `BUMP (Forced out #${juniorMan.sen})` 
                    });

                    // Mark the junior man as displaced so he evaluates his prefs in the next cascade
                    juniorMan.isDisplaced = true;
                    // Note: We don't change juniorMan's currentKey yet; the cascade will handle his move
                    
                    p.currentKey = targetKey;
                    p.moved = true;
                    p.isDisplaced = false;
                    cascade = true;
                    foundAward = true;
                    break;
                } else {
                    p.prefHistory[pr.order] = { status: "Denied", reason: `Full and no junior pilot to bump.` };
                }
            }
            if (foundAward || cascade) break; 
        }
        if (loops > 10000) break;
    }
    return { roster: bidders, loops, auditTrail };
}
