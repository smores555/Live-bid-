/**
 * THE 737 ADMIN ENGINE - TRUE VACANCY AWARE VERSION
 * Guarantees junior pilots are never displaced without a fleet reduction.
 */
function runBidEngine(data, deltaMap) {
    const auditTrail = [];
    const is737 = (seat) => seat && !seat.includes('320') && !seat.includes('321');
    const retiredSens = new Set(data.retired.filter(p => is737(p.seat)).map(p => p.seniority));
    const noBidSens = new Set(data.noBid.filter(p => is737(p.seat)).map(p => p.sen));

    let origRemaining = {};
    let currentCounts = {}; 
    let targetMap = {};

    // 1. Calculate EXACT starting headcount based on the actual roster
    data.roster.forEach(p => {
        if (is737(p.current.seat) && !retiredSens.has(p.sen) && !noBidSens.has(p.sen)) {
            const key = `${p.current.base}-${p.current.seat}`.toUpperCase();
            origRemaining[key] = (origRemaining[key] || 0) + 1;
        }
    });

    // 2. Set Hard Capacities using actual roster counts + deltas
    data.caps.forEach(c => {
        const key = `${c.base}-${c.seat}`.toUpperCase();
        const actualStart = origRemaining[key] || 0;
        targetMap[key] = actualStart + (deltaMap[`${c.base}-${c.seat}`] || 0);
        currentCounts[key] = 0; // Tracks awarded slots
    });

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
            const bplOnOwn = (prefData.preferences || []).some(pr => getTargetKey(pr.bid) === pilotOrig && (pr.bpl || pr.bpl_min));

            return {
                ...p, orig: pilotOrig, currentKey: "UNASSIGNED", moved: false, isSelfDisp: false, isUnassigned: false,
                awardedPrefNum: "N/A", awardedReason: "", bplOnOwn: bplOnOwn,
                prefs: (prefData.preferences || []).map(pr => ({
                    ...pr, targetKey: getTargetKey(pr.bid), bpl: parseInt(pr.bpl || pr.bpl_min) || 9999
                })).sort((a, b) => a.order - b.order)
            };
        }).sort((a, b) => a.sen - b.sen);

    bidders.forEach(p => {
        let awarded = false;

        // Decrement remaining originals as we process this pilot
        if (origRemaining[p.orig] > 0) origRemaining[p.orig]--;

        // STEP A: EVALUATE BIDS (Strict Vacancy Enforcement)
        for (const pr of p.prefs) {
            if (!pr.targetKey) continue;
            let cap = targetMap[pr.targetKey] || 0;
            let awardedSoFar = currentCounts[pr.targetKey] || 0;
            let rankInTarget = awardedSoFar + 1;

            let hasVacancy = false;
            if (pr.targetKey === p.orig) {
                // Holding own seat: Just needs to be under the final capacity
                hasVacancy = awardedSoFar < cap;
            } else {
                // Bidding new seat: Requires an actual open vacancy
                let remainingOriginals = origRemaining[pr.targetKey] || 0;
                hasVacancy = (cap - remainingOriginals - awardedSoFar) > 0;
            }

            if (hasVacancy && rankInTarget <= pr.bpl) {
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

        // STEP B: SENIORITY HOLD
        if (!awarded && !p.bplOnOwn) {
            let cap = targetMap[p.orig] || 0;
            let awardedSoFar = currentCounts[p.orig] || 0;
            if (awardedSoFar < cap) {
                p.currentKey = p.orig;
                currentCounts[p.orig]++;
                p.awardedReason = "Held Position (Seniority)";
                awarded = true;
            }
        }

        // STEP C: REDUCTION DISPLACEMENT
        if (!awarded) {
            p.currentKey = "UNASSIGNED";
            p.isUnassigned = true;
            p.wasSelfDisplaced = p.bplOnOwn;
            p.awardedReason = p.bplOnOwn ? "Self-Displaced (BPL)" : "Displaced (Fleet Reduction)";
            p.awardedPrefNum = "Pool";
            auditTrail.push({ sen: p.sen, name: p.name, to: "POOL", type: "Eviction" });
        }
    });

    return { roster: bidders, auditTrail, targetMap };
}
