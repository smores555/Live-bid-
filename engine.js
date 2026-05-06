/**
 * THE 737 ADMIN ENGINE - BPL RANK CONSTRAINT VERSION
 * Strictly honors BPL constraints and flags self-displacement.
 */
function runBidEngine(data, deltaMap) {
    const auditTrail = [];
    const is737 = (seat) => seat && !seat.includes('320') && !seat.includes('321');

    const retiredSens = new Set(data.retired.filter(p => is737(p.seat)).map(p => p.seniority));
    const noBidSens = new Set(data.noBid.filter(p => is737(p.seat)).map(p => p.sen));

    // Initialize Hard Capacities from capacities.json
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
                moved: false, wasSelfDisplaced: false, isUnassigned: false,
                awardedPrefNum: "N/A", awardedReason: "",
                // Parse BPL strings as integers
                prefs: (prefData.preferences || []).map(pr => ({
                    ...pr, bpl: parseInt(pr.bpl) || 9999
                })).sort((a, b) => a.order - b.order)
            };
        })
        .sort((a, b) => a.sen - b.sen); // Fill by Seniority

    bidders.forEach(p => {
        let awarded = false;
        // Check if they bid for their own current seat with a BPL constraint
        let ownSeatPref = p.prefs.find(pr => {
            const parts = pr.bid.trim().split(/\s+/);
            const tKey = (parts.length === 2) ? `${parts[1]}-${parts[0]}` : `${parts[1]}-${parts[2]}`;
            return tKey === p.orig;
        });

        // STEP A: EVALUATE BIDS (Strict BPL enforcement)
        for (const pr of p.prefs) {
            if (!pr.bid || pr.bid === "0") continue;
            const parts = pr.bid.trim().split(/\s+/);
            let targetKey = (parts.length === 2) ? `${parts[1]}-${parts[0]}` : `${parts[1]}-${parts[2]}`;
            let rankInTarget = currentCounts[targetKey] + 1;

            // Must fit under hard cap AND meet BPL rank
            if (currentCounts[targetKey] < targetMap[targetKey] && rankInTarget <= pr.bpl) {
                p.currentKey = targetKey;
                currentCounts[targetKey]++;
                p.awardedPrefNum = pr.order;
                p.awardedReason = (targetKey === p.orig) ? "Held Position" : "Bid Awarded";
                p.moved = (targetKey !== p.orig);
                awarded = true;
                auditTrail.push({ sen: p.sen, name: p.name, to: targetKey, type: "Award" });
                break;
            }
        }

        // STEP B: AUTOMATIC HOLD (Only if they didn't put a BPL restriction on their own seat)
        if (!awarded && !ownSeatPref) {
            const targetKey = p.orig;
            if (currentCounts[targetKey] < targetMap[targetKey]) {
                p.currentKey = targetKey;
                currentCounts[targetKey]++;
                p.awardedReason = "Held Position (Seniority)";
                awarded = true;
            }
        }

        // STEP C: DISPLACEMENT LOGIC (Flagging BPL failures)
        if (!awarded) {
            p.currentKey = "UNASSIGNED";
            p.isUnassigned = true;
            
            // If they bid for their own seat but failed BPL, flag as Self-Displaced
            if (ownSeatPref) {
                p.wasSelfDisplaced = true;
                p.awardedReason = `Self-Displaced (BPL ${ownSeatPref.bpl} Failed)`;
            } else {
                p.awardedReason = "Displaced (Over Capacity)";
            }
            
            p.awardedPrefNum = "Pool";
            auditTrail.push({ sen: p.sen, name: p.name, to: "POOL", type: p.wasSelfDisplaced ? "Self-Displacement" : "Eviction" });
        }
    });

    return { roster: bidders, auditTrail, targetMap };
}

/**
 * UPDATED TABLE RENDERING
 * Adds specific visual flags for Self-Displaced pilots.
 */
function renderTable(roster, targetMap) {
    document.getElementById('tableBody').innerHTML = roster.map(p => {
        const awardedPos = p.currentKey.replace('-', ' ');
        let tag = '';
        if (p.wasSelfDisplaced) tag = '<span class="tag" style="background:var(--red); color:white;">BPL SELF-DISPLACED</span>';
        else if (p.isUnassigned) tag = '<span class="tag unassigned-tag">AT MERCY</span>';
        else if (p.moved) tag = '<span class="tag displaced-tag">AWARDED</span>';
        
        let finalRank = 1;
        roster.forEach(other => { if (other.sen < p.sen && other.currentKey === p.currentKey) finalRank++; });
        const limit = targetMap[p.currentKey] || 0;

        return `
            <tr>
                <td>${p.sen}</td>
                <td><strong>${p.name}</strong><br>${tag}</td>
                <td style="color:${p.moved?'#3fb950':''}">${awardedPos}</td>
                <td><span class="rank-badge">${p.currentKey === "UNASSIGNED" ? "-" : finalRank + " / " + limit}</span></td>
                <td>
                    <span class="award-detail">${p.awardedPrefNum === "N/A" ? "Original" : "Pref #" + p.awardedPrefNum}</span>
                    <span class="award-reason">via ${p.awardedReason}</span>
                </td>
                <td>${p.orig.replace('-',' ')}</td>
            </tr>`;
    }).join('');
}
