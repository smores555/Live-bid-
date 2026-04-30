/**
 * AIRLINE BID ENGINE - BPL & Self-Displacement Logic
 * 1. Deduplicate: One pilot object per seniority number.
 * 2. Rank Calculation: Counts ALL pilots (Active, Retired, No-Bid) senior to the pilot.
 * 3. BPL Priority: Checks BPL even for the pilot's current seat.
 * 4. Exact Strings: Matches company "Denied" and "Awarded" messaging.
 */
function runBidEngine(data, deltaMap, trackSen = null) {
    const auditTrail = [];
    const retiredSens = new Set(data.retired.map(p => p.seniority));
    const noBidSens = new Set(data.noBid.map(p => p.sen));

    // Identify all Retired/No-Bid positions for Rank math
    const ghostPositions = {};
    data.retired.forEach(p => ghostPositions[p.seniority] = `${p.base}-${p.seat}`);
    data.noBid.forEach(p => ghostPositions[p.sen] = `${p.base}-${p.seat}`);

    // 1. Initialize Counts and Bidders
    const rosterMap = new Map();
    data.roster.forEach(p => { if (!rosterMap.has(p.sen)) rosterMap.set(p.sen, p); });

    let currentCounts = {};
    data.caps.forEach(c => currentCounts[`${c.base}-${c.seat}`] = 0);

    const bidders = Array.from(rosterMap.values())
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

    // 2. Set Hard Targets
    let targetMap = {};
    for (let key in currentCounts) {
        targetMap[key] = currentCounts[key] + (deltaMap[key] || 0);
    }
    for (let key in deltaMap) {
        if (targetMap[key] === undefined) targetMap[key] = deltaMap[key];
    }

    let cascade = true;
    let loops = 0;

    // 3. Cascade Engine
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
                
                // --- RANK CALCULATION (BPL IF AWARDED) ---
                // Count ALL pilots (Bidders + Ghosts) more senior than 'p' in the 'targetKey'
                let rank = 1;
                // Count senior active bidders
                for (const other of bidders) {
                    if (other.sen >= p.sen) break;
                    if (other.currentKey === targetKey) rank++;
                }
                // Count senior ghosts (Retired/No-Bid)
                for (let senNum in ghostPositions) {
                    if (parseInt(senNum) < p.sen && ghostPositions[senNum] === targetKey) rank++;
                }

                // --- BPL CHECK (Check even for current seat) ---
                const reqBPL = parseInt(pr.bpl_min) || 0;
                if (reqBPL > 0 && rank > reqBPL) {
                    p.prefHistory[pr.order] = { 
                        status: "Denied", 
                        reason: `Bid request does not meet BPL requirement. Requested BPL = ${reqBPL}. BPL if awarded = ${rank}.` 
                    };
                    continue; // Skip and check next preference
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
        if (loops > 5000) break; // Lower safety limit for testing
    }
    return { roster: bidders, loops, auditTrail };
}
