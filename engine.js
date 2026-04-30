/**
 * AIRLINE BID ENGINE - 737 ACTIVE-RANK EDITION
 * Logic:
 * 1. Fleet Purge: Ignores all 320/321 pilots.
 * 2. Rank Math: Counts ONLY senior Active Bidders for BPL.
 * 3. Seat Integrity: No-Bid pilots occupy seats but don't count toward BPL.
 * 4. Seniority Cascade: Restarts from #1 after every award to preserve seniority rights.
 */
function runBidEngine(data, deltaMap) {
    const auditTrail = [];
    
    // 1. Scrub the Data - Identify 737 only
    const is737 = (seat) => seat && !seat.includes('320') && !seat.includes('321');

    const retiredSens = new Set(data.retired.filter(p => is737(p.seat)).map(p => p.seniority));
    const noBid737 = data.noBid.filter(p => is737(p.seat));
    const noBidSens = new Set(noBid737.map(p => p.sen));

    // Map No-Bids for seat occupancy (but we will ignore them in Rank loop later)
    const noBidOccupancy = {};
    noBid737.forEach(p => noBidOccupancy[p.sen] = `${p.base}-${p.seat}`);

    // 2. Initialize Current Occupancy (Physical Seats)
    let currentCounts = {};
    data.caps.forEach(c => currentCounts[`${c.base}-${c.seat}`] = 0);

    // Initial Seats for No-Bid pilots (Fixed)
    for (let sen in noBidOccupancy) {
        const key = noBidOccupancy[sen];
        if (currentCounts[key] === undefined) currentCounts[key] = 0;
        currentCounts[key]++;
    }

    // 3. Filter and Prepare Active Bidders
    const rosterMap = new Map();
    data.roster.forEach(p => {
        if (!rosterMap.has(p.sen) && is737(p.current.seat)) {
            rosterMap.set(p.sen, p);
        }
    });

    const bidders = Array.from(rosterMap.values())
        .filter(p => !retiredSens.has(p.sen) && !noBidSens.has(p.sen))
        .map(p => {
            const key = `${p.current.base}-${p.current.seat}`;
            if (currentCounts[key] === undefined) currentCounts[key] = 0;
            currentCounts[key]++; // Occupy current seat initially
            
            const prefData = data.prefs['pil' + p.sen] || data.prefs[p.id] || { preferences: [] };
            
            return {
                ...p, 
                currentKey: key, 
                orig: key, 
                moved: false,
                prefHistory: {}, 
                prefs: (prefData.preferences || []).sort((a, b) => a.order - b.order)
            };
        }).sort((a, b) => a.sen - b.sen);

    // 4. Set Hard Targets (Initial Count + Delta)
    let targetMap = {};
    for (let key in currentCounts) {
        targetMap[key] = currentCounts[key] + (deltaMap[key] || 0);
    }

    let cascade = true;
    let loops = 0;

    // 5. The Seniority Cascade
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
                
                // --- RANK CALCULATION (ACTIVE BIDDERS ONLY) ---
                // Only count other active bidders senior to 'p' currently in the targetKey
                let rank = 1;
                for (const other of bidders) {
                    if (other.sen >= p.sen) break;
                    if (other.currentKey === targetKey) rank++;
                }

                const reqBPL = parseInt(pr.bpl_min) || 0;
                const bplLog = reqBPL > 0 ? `. Requested BPL = ${reqBPL}. BPL if awarded = ${rank}.` : `. BPL if awarded = ${rank}.`;

                // --- BPL CHECK ---
                if (reqBPL > 0 && rank > reqBPL) {
                    p.prefHistory[pr.order] = { 
                        status: "Denied", 
                        reason: `Bid request does not meet BPL requirement. Requested BPL = ${reqBPL}. BPL if awarded = ${rank}.` 
                    };
                    continue; // Failed BPL, move to next preference
                }

                // --- REMAIN IN POSITION ---
                if (targetKey === p.currentKey) {
                    p.prefHistory[pr.order] = { status: "Awarded", reason: `Remain in current position${bplLog}` };
                    break; // Pilot is in best available seat, stop preferences
                }

                // --- CAPACITY CHECK ---
                const currentOcc = currentCounts[targetKey] || 0;
                const limit = targetMap[targetKey] || 0;
                const targetVacancies = limit - currentOcc;

                if (currentOcc < limit) {
                    const oldKey = p.currentKey;
                    const oldLimit = targetMap[oldKey] || 0;
                    const oldOcc = currentCounts[oldKey] || 0;
                    const oldVacancies = oldLimit - oldOcc;

                    // Perform the move
                    currentCounts[oldKey]--; 
                    currentCounts[targetKey]++;

                    const targetVacAfter = limit - currentCounts[targetKey];
                    const oldVacAfter = oldLimit - currentCounts[oldKey];

                    p.prefHistory[pr.order] = { 
                        status: "Awarded", 
                        reason: `Open position available. Reduce vacancy in ${targetKey} from ${targetVacancies} to ${targetVacAfter}. Increase vacancy in ${oldKey} from ${oldVacancies} to ${oldVacAfter}${bplLog}` 
                    };

                    auditTrail.push({
                        loop: loops, 
                        sen: p.sen, 
                        name: p.name, 
                        from: oldKey, 
                        to: targetKey,
                        fromTrans: `${oldVacancies} -> ${oldVacAfter}`,
                        toTrans: `${targetVacancies} -> ${targetVacAfter}`
                    });
                    
                    p.currentKey = targetKey;
                    p.moved = true;
                    cascade = true; // RESTART FROM PILOT #1
                    break; 
                } else {
                    p.prefHistory[pr.order] = { 
                        status: "Denied", 
                        reason: `Requested position has ${targetVacancies} vacancy and cannot accept additional pilots.` 
                    };
                }
            }
            if (cascade) break; // Exit bidder loop to restart at seniority #1
        }
        if (loops > 10000) break; // Safety break
    }
    return { roster: bidders, loops, auditTrail };
}
