/**
 * THE 737 ADMIN ENGINE - HARD BPL FAIL-SAFE VERSION
 * Guarantees junior pilots are never displaced without a reduction,
 * UNLESS they fail their own BPL constraint (Self-Displacement).
 */
function runBidEngine(data, deltaMap) {
    const auditTrail = [];
    const is737 = (seat) => seat && !seat.includes('320') && !seat.includes('321');
    const retiredSens = new Set(data.retired.filter(p => is737(p.seat)).map(p => p.seniority));
    const noBidSens = new Set(data.noBid.filter(p => is737(p.seat)).map(p => p.sen));

    let origRemaining = {};
    let currentCounts = {}; 
    let targetMap = {};

    // 1. Calculate precise starting counts from actual roster
    data.roster.forEach(p => {
        if (is737(p.current.seat) && !retiredSens.has(p.sen) && !noBidSens.has(p.sen)) {
            const key = `${p.current.base}-${p.current.seat}`.toUpperCase();
            origRemaining[key] = (origRemaining[key] || 0) + 1;
        }
    });

    data.caps.forEach(c => {
        const key = `${c.base}-${c.seat}`.toUpperCase();
        const actualStart = origRemaining[key] || 0;
        targetMap[key] = actualStart + (deltaMap[`${c.base}-${c.seat}`] || 0);
        currentCounts[key] = 0; 
    });

    // KEYWORD SCANNER: Corrects for "73G SAN FO" or empty bids
    const getTargetKey = (bidStr) => {
        if (!bidStr || String(bidStr).trim() === "" || bidStr === "0") return null;
        const parts = String(bidStr).trim().toUpperCase().split(/\s+/);
        const bases = ['SEA', 'PDX', 'ANC', 'SFO', 'LAX', 'SAN', 'LAS'];
        const seats = ['CA', 'FO'];
        let b = parts.find(x => bases.includes(x));
        let s = parts.find(x => seats.includes(x));
        return (b && s) ? `${b}-${s}` : null;
    };

    const bidders = data.roster
        .filter(p => is737(p.current.seat) && !retiredSens.has(p.sen) && !noBidSens.has(p.sen))
        .map(p => {
            let found = data.prefs['pil' + p.sen] || data.prefs[p.id] || data.prefs[p.sen];
            let prefData = found ? (found.preferences || found.bids || []) : [];
            const pilotOrig = `${p.current.base}-${p.current.seat}`.toUpperCase();

            const cleanPrefs = prefData.map(pr => ({
                ...pr,
                targetKey: getTargetKey(pr.bid || pr.position),
                bpl_min: parseInt(pr.bpl_min || pr.bpl || 0)
            })).filter(pr => pr.targetKey);

            // REAPING LOGIC: Specifically captures the BPL on the pilot's own seat
            const ownSeatBpl = cleanPrefs.find(pr => pr.targetKey === pilotOrig)?.bpl_min || 0;

            return {
                ...p, orig: pilotOrig, currentKey: "UNASSIGNED", moved: false, isSelfDisp: false, isUnassigned: false,
                awardedPrefNum: "N/A", awardedReason: "", ownSeatBpl: ownSeatBpl,
                prefs: cleanPrefs
            };
        }).sort((a, b) => a.sen - b.sen);

    bidders.forEach(p => {
        let awarded = false;
        if (origRemaining[p.orig] > 0) origRemaining[p.orig]--;

        // STEP A: EVALUATE BIDS (Strict Vacancy & BPL Enforcement)
        for (const pr of p.prefs) {
            let cap = targetMap[pr.targetKey] || 0;
            let awardedSoFar = currentCounts[pr.targetKey] || 0;
            let rankInTarget = awardedSoFar + 1;

            // BPL Check
            const bplLimit = pr.bpl_min > 0 ? pr.bpl_min : 9999;
            if (rankInTarget > bplLimit) continue;

            // Vacancy Check (Backfill Aware)
            let hasVacancy = false;
            if (pr.targetKey === p.orig) {
                hasVacancy = awardedSoFar < cap;
            } else {
                let remainingOriginals = origRemaining[pr.targetKey] || 0;
                hasVacancy = (cap - remainingOriginals - awardedSoFar) > 0;
            }

            if (hasVacancy) {
                p.currentKey = pr.targetKey;
                currentCounts[pr.targetKey]++;
                p.awardedPrefNum = pr.order;
                p.awardedReason = (pr.targetKey === p.orig) ? "Held Position (Bid)" : "Bid Awarded";
                p.moved = (pr.targetKey !== p.orig);
                awarded = true;
                break;
            }
        }

        // STEP B: SENIORITY HOLD (The Fail-Safe Fix)
        // If they didn't award a bid, check if they can stay WITHOUT failing their BPL
        if (!awarded) {
            let cap = targetMap[p.orig] || 0;
            let awardedSoFar = currentCounts[p.orig] || 0;
            let rank = awardedSoFar + 1;
            
            // THE SETH FIX: No safety net if rank > bpl_min
            const bplLimit = p.ownSeatBpl > 0 ? p.ownSeatBpl : 9999;

            if (rank <= cap && rank <= bplLimit) {
                p.currentKey = p.orig;
                currentCounts[p.orig]++;
                p.awardedReason = "Held Position (Seniority)";
                awarded = true;
            }
        }

        // STEP C: DISPLACEMENT
        if (!awarded) {
            p.currentKey = "UNASSIGNED";
            p.isUnassigned = true;
            // If they had a BPL on their own seat, it's a Self-Displacement
            p.wasSelfDisplaced = p.ownSeatBpl > 0;
            p.awardedReason = p.wasSelfDisplaced ? "Self-Displaced (BPL Fail)" : "Displaced (Reduction)";
            p.awardedPrefNum = "Pool";
        }
    });

    return { roster: bidders, auditTrail, targetMap };
}
