/**
 * UPDATED AIRLINE BID ENGINE
 * Fixes: Corrected preference parsing for "73G SEAT BASE" format 
 * and fixed ID lookups for the preferences object.
 */
function runBidEngine(data, deltaMap) {
    const auditTrail = [];
    
    // 1. Scrub the Data - Identify 737 only
    const is737 = (seat) => seat && !seat.includes('320') && !seat.includes('321');

    const retiredSens = new Set(data.retired.filter(p => is737(p.seat)).map(p => p.sen));
    const noBid737 = data.noBid.filter(p => is737(p.seat));
    const noBidSens = new Set(noBid737.map(p => p.sen));

    const noBidOccupancy = {};
    noBid737.forEach(p => noBidOccupancy[p.sen] = `${p.base}-${p.seat}`);

    // 2. Initialize Current Occupancy
    let currentCounts = {};
    data.caps.forEach(c => currentCounts[`${c.base}-${c.seat}`] = 0);

    for (let sen in noBidOccupancy) {
        const key = noBidOccupancy[sen];
        if (currentCounts[key] === undefined) currentCounts[key] = 0;
        currentCounts[key]++;
    }

    // 3. Prepare Active Bidders
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
            currentCounts[key]++; 
            
            // Fix: Check for both "pil123" and raw "123" seniority keys
            const prefData = data.prefs['pil' + p.sen] || data.prefs[p.sen] || { preferences: [] };
            
            return {
                ...p, 
                currentKey: key, 
                orig: key, 
                moved: false,
                prefHistory: {}, 
                prefs: (prefData.preferences || []).sort((a, b) => a.order - b.order)
            };
        }).sort((a, b) => a.sen - b.sen);

    // 4. Set Hard Targets
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
                if (!pr.bid || pr.bid.trim() === "") continue;
                
                // Fix: Parse "73G SEAT BASE" (e.g. "73G CA SEA")
                const parts = pr.bid.trim().split(/\s+/);
                if (parts.length < 3) continue;
                const targetKey = `${parts[2]}-${parts[1]}`; // Result: SEA-CA
                
                // --- RANK CALCULATION ---
                let rank = 1;
                for (const other of bidders) {
                    if (other.sen >= p.sen) break;
                    if (other.currentKey === targetKey) rank++;
                }

                const reqBPL = parseInt(pr.bpl_min) || 0;
                const bplLog = `. BPL if awarded = ${rank}${reqBPL > 0 ? ` (Req: ${reqBPL})` : ''}`;

                if (reqBPL > 0 && rank > reqBPL) {
                    p.prefHistory[pr.order] = { 
                        status: "Denied", 
                        reason: `BPL requirement failed. Rank: ${rank}, Req: ${reqBPL}` 
                    };
                    continue;
                }

                if (targetKey === p.currentKey) {
                    p.prefHistory[pr.order] = { status: "Awarded", reason: `Remain in current position${bplLog}` };
                    break;
                }

                // --- CAPACITY CHECK ---
                const currentOcc = currentCounts[targetKey] || 0;
                const limit = targetMap[targetKey] || 0;

                if (currentOcc < limit) {
                    const oldKey = p.currentKey;
                    
                    currentCounts[oldKey]--; 
                    currentCounts[targetKey]++;

                    p.prefHistory[pr.order] = { 
                        status: "Awarded", 
                        reason: `Awarded ${targetKey} (Vacancy was ${limit - currentOcc})${bplLog}` 
                    };

                    auditTrail.push({
                        loop: loops, sen: p.sen, name: p.name, from: oldKey, to: targetKey
                    });
                    
                    p.currentKey = targetKey;
                    p.moved = true;
                    cascade = true; 
                    break; 
                } else {
                    p.prefHistory[pr.order] = { 
                        status: "Denied", 
                        reason: `No vacancy in ${targetKey}` 
                    };
                }
            }
            if (cascade) break;
        }
        if (loops > 5000) break; // Safety limit
    }
    return { roster: bidders, loops, auditTrail };
}
