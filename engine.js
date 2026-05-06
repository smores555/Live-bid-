/**
 * THE 737 ADMIN ENGINE - BPL RANK CONSTRAINT VERSION
 * Handles "Self-Displacement" via BPL numbers.
 */
function runBidEngine(data, deltaMap) {
    const auditTrail = [];
    const is737 = (seat) => seat && !seat.includes('320') && !seat.includes('321');

    const retiredSens = new Set(data.retired.filter(p => is737(p.seat)).map(p => p.seniority));
    const noBidSens = new Set(data.noBid.filter(p => is737(p.seat)).map(p => p.sen));

    let targetMap = {};
    data.caps.forEach(c => {
        const key = `${c.base}-${c.seat}`;
        targetMap[key] = c.startCapacity + (deltaMap[key] || 0);
    });

    let currentCounts = {};
    Object.keys(targetMap).forEach(k => currentCounts[k] = 0);

    const bidders = data.roster
        .filter(p => is737(p.current.seat) && !retiredSens.has(p.sen) && !noBidSens.has(p.sen))
        .map(p => {
            const prefData = data.prefs['pil' + p.sen] || data.prefs[p.id] || { preferences: [] };
            return {
                ...p,
                orig: `${p.current.base}-${p.current.seat}`,
                currentKey: "UNASSIGNED",
                moved: false,
                wasDisplaced: false,
                isUnassigned: false,
                awardedPrefNum: "N/A",
                awardedReason: "",
                // Ensure BPL is treated as a number
                prefs: (prefData.preferences || []).map(pr => ({
                    ...pr,
                    bpl: parseInt(pr.bpl) || 99999 // Default to high number if no BPL set
                })).sort((a, b) => a.order - b.order)
            };
        })
        .sort((a, b) => a.sen - b.sen);

    bidders.forEach(p => {
        let awarded = false;
        let bidForOwnSeat = p.prefs.some(pr => {
            const parts = pr.bid.trim().split(/\s+/);
            const tKey = (parts.length === 2) ? `${parts[1]}-${parts[0]}` : `${parts[1]}-${parts[2]}`;
            return tKey === p.orig;
        });

        // STEP A: Try to award Bids (with BPL check)
        for (const pr of p.prefs) {
            if (!pr.bid || pr.bid === "0") continue;
            
            const parts = pr.bid.trim().split(/\s+/);
            let targetKey = (parts.length === 2) ? `${parts[1]}-${parts[0]}` : `${parts[1]}-${parts[2]}`;
            let rankInBase = currentCounts[targetKey] + 1;

            // CONDITION: Must be under Base Cap AND meet the Pilot's BPL Rank
            if (currentCounts[targetKey] < targetMap[targetKey] && rankInBase <= pr.bpl) {
                p.currentKey = targetKey;
                currentCounts[targetKey]++;
                p.awardedPrefNum = pr.order;
                p.awardedReason = (targetKey === p.orig) ? "Held Position" : "Bid Award";
                p.moved = (targetKey !== p.orig);
                awarded = true;
                auditTrail.push({ pass: 1, sen: p.sen, name: p.name, to: targetKey, type: "Award" });
                break;
            }
        }

        // STEP B: Automatic Hold
        // ONLY triggers if they DID NOT bid for their own seat with a condition (like Seth)
        if (!awarded && !bidForOwnSeat) {
            const targetKey = p.orig;
            if (currentCounts[targetKey] < targetMap[targetKey]) {
                p.currentKey = targetKey;
                currentCounts[targetKey]++;
                p.awardedReason = "Held Position (Seniority)";
                awarded = true;
            }
        }

        // STEP C: Category Sweep (Only if they haven't explicitly "bid" themselves out)
        if (!awarded && !bidForOwnSeat) {
            const seatType = p.current.seat;
            for (let key in targetMap) {
                if (key.endsWith(`-${seatType}`) && currentCounts[key] < targetMap[key]) {
                    p.currentKey = key;
                    currentCounts[key]++;
                    p.awardedReason = `${seatType} Category Vacancy`;
                    p.awardedPrefNum = "Sweep";
                    p.moved = true;
                    awarded = true;
                    break;
                }
            }
        }

        // STEP D: POOL / SELF-DISPLACEMENT
        if (!awarded) {
            p.currentKey = "UNASSIGNED";
            p.isUnassigned = true;
            p.wasDisplaced = true;
            p.awardedReason = bidForOwnSeat ? "Self-Displaced (BPL Failed)" : "Displaced (Over Capacity)";
            p.awardedPrefNum = "Pool";
            auditTrail.push({ pass: 1, sen: p.sen, name: p.name, to: "POOL", type: "Displacement" });
        }
    });

    return { roster: bidders, loops: 1, auditTrail, targetMap };
}
