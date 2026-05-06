/**
 * AIRLINE BID ENGINE - NET ZERO CASCADE EDITION
 */
function runBidEngine(data, deltaMap) {
    const auditTrail = [];
    const is737 = (seat) => seat && !seat.includes('320') && !seat.includes('321');

    // 1. Identify Target Headcount (Target = Current + Growth/Reduction)
    let targetMap = {};
    data.caps.forEach(c => {
        const key = `${c.base}-${c.seat}`.toUpperCase();
        targetMap[key] = c.startCapacity + (deltaMap[key] || 0);
    });

    const retiredSens = new Set(data.retired.filter(p => is737(p.seat)).map(p => p.seniority));
    const noBidSens = new Set(data.noBid.filter(p => is737(p.seat)).map(p => p.sen));

    // 2. Initialize Counts (Process All 737 Pilots)
    let currentCounts = {};
    Object.keys(targetMap).forEach(k => currentCounts[k] = 0);

    // Bidders list sorted by seniority to start the cascade
    const bidders = data.roster
        .filter(p => is737(p.current.seat) && !retiredSens.has(p.sen) && !noBidSens.has(p.sen))
        .map(p => {
            const prefData = data.prefs['pil' + p.sen] || data.prefs[p.id] || { preferences: [] };
            const pilotOrig = `${p.current.base}-${p.current.seat}`.toUpperCase();
            
            return {
                ...p,
                orig: pilotOrig,
                currentKey: "UNASSIGNED",
                moved: false, wasSelfDisplaced: false, isUnassigned: false,
                awardedPrefNum: "N/A", awardedReason: "",
                prefs: (prefData.preferences || []).map(pr => {
                    const parts = pr.bid.trim().toUpperCase().split(/\s+/);
                    return {
                        ...pr, 
                        targetKey: `${parts[1]}-${parts[2]}`,
                        bpl: parseInt(pr.bpl || pr.bpl_min) || 9999
                    };
                }).sort((a, b) => a.order - b.order)
            };
        })
        .sort((a, b) => a.sen - b.sen);

    // 3. The Cascade Loop
    bidders.forEach(p => {
        let awarded = false;

        // Step A: Try Preferences
        for (const pr of p.prefs) {
            let rankInBase = currentCounts[pr.targetKey] + 1;
            let cap = targetMap[pr.targetKey] || 0;

            if (rankInBase <= cap && rankInBase <= pr.bpl) {
                p.currentKey = pr.targetKey;
                currentCounts[pr.targetKey]++;
                p.awardedPrefNum = pr.order;
                p.awardedReason = (pr.targetKey === p.orig) ? "Held Position (Bid)" : "Awarded Vacancy";
                p.moved = (pr.targetKey !== p.orig);
                awarded = true;
                auditTrail.push({ sen: p.sen, name: p.name, to: pr.targetKey, type: "Award" });
                break;
            }
        }

        // Step B: Seniority Hold (Net Zero Logic)
        // If they didn't bid out (or failed to), can they fit in their original seat?
        if (!awarded) {
            const selfBidOnOwnSeat = p.prefs.find(pr => pr.targetKey === p.orig);
            const bplFail = selfBidOnOwnSeat && (currentCounts[p.orig] + 1 > selfBidOnOwnSeat.bpl);

            // If base has room (because a senior person bid out), they "Hold"
            if (currentCounts[p.orig] < targetMap[p.orig] && !bplFail) {
                p.currentKey = p.orig;
                currentCounts[p.orig]++;
                p.awardedReason = "Held Position (Seniority)";
                awarded = true;
                p.moved = false;
            }
        }

        // Step C: Displacement
        if (!awarded) {
            p.currentKey = "UNASSIGNED";
            p.isUnassigned = true;
            p.moved = true;
            p.awardedReason = "Juniority Displacement";
            p.awardedPrefNum = "Pool";
            auditTrail.push({ sen: p.sen, name: p.name, to: "POOL", type: "Displacement" });
        }
    });

    return { roster: bidders, auditTrail, targetMap };
}
