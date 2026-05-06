/**
 * THE 737 ADMIN ENGINE - VACANCY-AWARE BPL VERSION
 * Robustly handles seniority holds and backfill vacancies.
 */
function runBidEngine(data, deltaMap) {
    const auditTrail = [];
    const is737 = (seat) => seat && !seat.includes('320') && !seat.includes('321');

    const retiredSens = new Set(data.retired.filter(p => is737(p.seat)).map(p => p.seniority));
    const noBidSens = new Set(data.noBid.filter(p => is737(p.seat)).map(p => p.sen));

    // 1. Initialize Hard Capacities
    let targetMap = {};
    data.caps.forEach(c => {
        const key = `${c.base}-${c.seat}`.toUpperCase();
        targetMap[key] = c.startCapacity + (deltaMap[`${c.base}-${c.seat}`] || 0);
    });

    let currentCounts = {};
    Object.keys(targetMap).forEach(k => currentCounts[k] = 0);

    // Helper to extract Base-Seat key from various bid formats
    const getTargetKey = (bidStr) => {
        if (!bidStr || bidStr === "0") return null;
        const parts = bidStr.trim().toUpperCase().split(/\s+/);
        const bases = ['SEA', 'PDX', 'ANC', 'SFO', 'LAX', 'SAN', 'LAS'];
        const seats = ['CA', 'FO'];
        let b = parts.find(x => bases.includes(x));
        let s = parts.find(x => seats.includes(x));
        return (b && s) ? `${b}-${s}` : null;
    };

    const bidders = data.roster
        .filter(p => is737(p.current.seat) && !retiredSens.has(p.sen) && !noBidSens.has(p.sen))
        .map(p => {
            const prefData = data.prefs['pil' + p.sen] || data.prefs[p.id] || { preferences: [] };
            const pilotOrig = `${p.current.base}-${p.current.seat}`.toUpperCase();
            
            // Check if user specifically put a BPL on their current position
            const bplOnOwn = (prefData.preferences || []).some(pr => 
                getTargetKey(pr.bid) === pilotOrig && (pr.bpl || pr.bpl_min)
            );

            return {
                ...p,
                orig: pilotOrig,
                currentKey: "UNASSIGNED",
                moved: false, wasSelfDisplaced: false, isUnassigned: false,
                awardedPrefNum: "N/A", awardedReason: "",
                bplOnOwn: bplOnOwn,
                prefs: (prefData.preferences || []).map(pr => ({
                    ...pr, 
                    targetKey: getTargetKey(pr.bid),
                    bpl: parseInt(pr.bpl || pr.bpl_min) || 9999
                })).sort((a, b) => a.order - b.order)
            };
        })
        .sort((a, b) => a.sen - b.sen);

    bidders.forEach(p => {
        let awarded = false;

        // STEP A: EVALUATE BIDS (Seniority Displacement/Movement)
        for (const pr of p.prefs) {
            if (!pr.targetKey) continue;
            let rankInTarget = currentCounts[pr.targetKey] + 1;
            let cap = targetMap[pr.targetKey] || 0;

            if (rankInTarget <= cap && rankInTarget <= pr.bpl) {
                p.currentKey = pr.targetKey;
                currentCounts[pr.targetKey]++;
                p.awardedPrefNum = pr.order;
                p.awardedReason = (pr.targetKey === p.orig) ? "Held Position (Bid)" : "Bid Awarded";
                p.moved = (pr.targetKey !== p.orig);
                awarded = true;
                auditTrail.push({ sen: p.sen, name: p.name, to: pr.targetKey, type: "Award" });
                break;
            }
        }

        // STEP B: SENIORITY HOLD (Backfill Logic)
        // If they didn't award a bid and didn't use BPL to force themselves out
        if (!awarded && !p.bplOnOwn) {
            const targetKey = p.orig;
            let cap = targetMap[targetKey] || 0;
            let rank = currentCounts[targetKey] + 1;

            if (rank <= cap) {
                p.currentKey = targetKey;
                currentCounts[targetKey]++;
                p.awardedReason = "Held Position (Seniority)";
                awarded = true;
            }
        }

        // STEP C: DISPLACEMENT
        if (!awarded) {
            p.currentKey = "UNASSIGNED";
            p.isUnassigned = true;
            if (p.bplOnOwn) {
                p.wasSelfDisplaced = true;
                p.awardedReason = "Self-Displaced (BPL)";
            } else {
                p.awardedReason = "Displaced (Juniority)";
            }
            p.awardedPrefNum = "Pool";
            auditTrail.push({ sen: p.sen, name: p.name, to: "POOL", type: p.wasSelfDisplaced ? "Self-Displacement" : "Eviction" });
        }
    });

    return { roster: bidders, auditTrail, targetMap };
}
