/**
 * AIRLINE BID ENGINE - 737 ACTIVE-RANK EDITION
 * Updated for compatibility with Dashboard UI
 */
function runBidEngine(data, deltaMap) {
    const auditTrail = [];
    
    // 1. Scrub the Data - Identify 737 only
    const is737 = (seat) => seat && !seat.includes('320') && !seat.includes('321');

    const retiredSens = new Set(data.retired.filter(p => is737(p.seat)).map(p => p.seniority));
    const noBid737 = data.noBid.filter(p => is737(p.seat));
    const noBidSens = new Set(noBid737.map(p => p.sen));

    // Map No-Bids for seat occupancy (they occupy seats but don't count toward BPL)
    const noBidOccupancy = {};
    noBid737.forEach(p => noBidOccupancy[p.sen] = `${p.base}-${p.seat}`.toUpperCase());

    // 2. Initialize Current Occupancy (Physical Seats)
    let currentCounts = {};
    data.caps.forEach(c => currentCounts[`${c.base}-${c.seat}`.toUpperCase()] = 0);

    // Initial Seats for No-Bid pilots
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
            const key = `${p.current.base}-${p.current.seat}`.toUpperCase();
            if (currentCounts[key] === undefined) currentCounts[key] = 0;
            currentCounts[key]++; // Occupy current seat initially
            
            const prefData = data.prefs['pil' + p.sen] || data.prefs[p.id] || { preferences: [] };
            
            return {
                ...p, 
                currentKey: key, 
                orig: key, 
                moved: false,
                isUnassigned: false,
                awardedPrefNum: "N/A",
                awardedReason: "Pending...",
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
                const parts = pr.bid.trim().toUpperCase().split(/\s+/);
                if (parts.length < 3) continue;
                const targetKey = `${parts[1]}-${parts[2]}`;
                
                // --- RANK CALCULATION (ACTIVE BIDDERS ONLY) ---
                let rank = 1;
                for (const other of bidders) {
                    if (other.sen >= p.sen) break;
                    if (other.currentKey === targetKey) rank++;
                }

                const reqBPL = parseInt(pr.bpl_min || pr.bpl) || 9999;
                const bplLog = `. BPL if awarded = ${rank}.`;

                // --- BPL CHECK ---
                if (reqBPL > 0 && rank > reqBPL) {
                    p.awardedReason = `Denied: Rank ${rank} exceeds BPL ${reqBPL}`;
                    continue; 
                }

                // --- REMAIN IN POSITION ---
                if (targetKey === p.currentKey) {
                    p.awardedReason = `Awarded Preference #${pr.order}. Remained in current position.`;
                    p.moved = false;
                    p.awardedPrefNum = pr.order;
                    break; 
                }

                // --- CAPACITY CHECK ---
                const currentOcc = currentCounts[targetKey] || 0;
                const limit = targetMap[targetKey] || 0;
                const targetVacancies = limit - currentOcc;

                if (currentOcc < limit) {
                    const oldKey = p.currentKey;
                    const oldLimit = targetMap[oldKey] || 0;
                    const oldOcc = currentCounts[oldKey] || 0;

                    // Perform the move
                    currentCounts[oldKey]--; 
                    currentCounts[targetKey]++;

                    const targetVacAfter = limit - currentCounts[targetKey];
                    const oldVacAfter = oldLimit - currentCounts[oldKey];

                    p.awardedReason = `Awarded Pref #${pr.order} via Vacancy. Move to ${targetKey}.`;
                    p.awardedPrefNum = pr.order;
                    p.currentKey = targetKey;
                    p.moved = true;

                    auditTrail.push({
                        loop: loops, 
                        sen: p.sen, 
                        name: p.name, 
                        from: oldKey, 
                        to: targetKey
                    });
                    
                    cascade = true; // RESTART FROM PILOT #1
                    break; 
                }
            }
            if (cascade) break; 
        }
        if (loops > 10000) break; // Safety break
    }

    // Post-pass: Identify any pilots who couldn't hold anything
    bidders.forEach(p => {
        if (p.awardedPrefNum === "N/A" && p.currentKey !== p.orig) {
             // Seniority-based displacement logic for those who fail all bids
             // This can be expanded further for Section 24 compliance
        }
    });

    return { roster: bidders, loops, auditTrail, targetMap };
}
