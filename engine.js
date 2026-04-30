/**
 * AIRLINE BID ENGINE - INVOLUNTARY DISPLACEMENT LOGIC
 * 1. Hard Targets: Enforced strictly. If a base is shrinking, junior pilots are bumped.
 * 2. Involuntary Flag: If a pilot's "Remain" bid is denied due to capacity, they are flagged.
 * 3. Priority: Seniority still rules. Senior pilots get the "Stay" slots first.
 */
function runBidEngine(data, deltaMap) {
    const auditTrail = [];
    const is737 = (seat) => seat && !seat.includes('320') && !seat.includes('321');

    const retiredSens = new Set(data.retired.filter(p => is737(p.seat)).map(p => p.seniority));
    const noBid737 = data.noBid.filter(p => is737(p.seat));
    const noBidSens = new Set(noBid737.map(p => p.sen));

    const noBidOccupancy = {};
    noBid737.forEach(p => noBidOccupancy[p.sen] = `${p.base}-${p.seat}`);

    let currentCounts = {};
    data.caps.forEach(c => currentCounts[`${c.base}-${c.seat}`] = 0);

    for (let sen in noBidOccupancy) {
        const key = noBidOccupancy[sen];
        currentCounts[key] = (currentCounts[key] || 0) + 1;
    }

    const rosterMap = new Map();
    data.roster.forEach(p => {
        if (!rosterMap.has(p.sen) && is737(p.current.seat)) rosterMap.set(p.sen, p);
    });

    const bidders = Array.from(rosterMap.values())
        .filter(p => !retiredSens.has(p.sen) && !noBidSens.has(p.sen))
        .map(p => {
            const key = `${p.current.base}-${p.current.seat}`;
            currentCounts[key] = (currentCounts[key] || 0) + 1;
            const prefData = data.prefs['pil' + p.sen] || data.prefs[p.id] || { preferences: [] };
            return {
                ...p, currentKey: key, orig: key, moved: false,
                prefHistory: {}, 
                prefs: (prefData.preferences || []).sort((a, b) => a.order - b.order)
            };
        }).sort((a, b) => a.sen - b.sen);

    let targetMap = {};
    for (let key in currentCounts) {
        targetMap[key] = currentCounts[key] + (deltaMap[key] || 0);
    }

    let cascade = true;
    let loops = 0;

    while (cascade) {
        cascade = false;
        loops++;
        for (let i = 0; i < bidders.length; i++) {
            const p = bidders[i];
            let displacementImminent = false;

            for (const pr of p.prefs) {
                if (!pr.bid) continue;
                const parts = pr.bid.trim().split(/\s+/);
                if (parts.length < 3) continue;
                const targetKey = `${parts[1]}-${parts[2]}`;
                
                // --- RANK CALCULATION ---
                let rank = 1;
                for (const other of bidders) {
                    if (other.sen >= p.sen) break;
                    if (other.currentKey === targetKey) rank++;
                }

                const reqBPL = parseInt(pr.bpl_min) || 0;
                const bplLog = `. Requested BPL = ${reqBPL}. BPL if awarded = ${rank}.`;

                // BPL CHECK
                if (reqBPL > 0 && rank > reqBPL) {
                    p.prefHistory[pr.order] = { status: "Denied", reason: `BPL Fail${bplLog}` };
                    continue; 
                }

                const currentOcc = currentCounts[targetKey] || 0;
                const limit = targetMap[targetKey] || 0;
                const vBefore = limit - currentOcc;

                // --- REMAIN IN POSITION LOGIC (With Displacement Check) ---
                if (targetKey === p.currentKey) {
                    // If base is full/shrinking and this junior pilot didn't make the cut
                    if (currentOcc >= limit) {
                        p.prefHistory[pr.order] = { 
                            status: "Denied", 
                            reason: `Involuntary Displacement: Position at hard capacity (${limit}/${limit}).` 
                        };
                        displacementImminent = true;
                        continue; // Force them to look at next preference
                    } else {
                        p.prefHistory[pr.order] = { status: "Awarded", reason: `Remain in current position${bplLog}` };
                        break;
                    }
                }

                // --- AWARD NEW POSITION ---
                if (currentOcc < limit) {
                    const oldKey = p.currentKey;
                    const oldLimit = targetMap[oldKey] || 0;
                    const oldOcc = currentCounts[oldKey] || 0;
                    const oldV = oldLimit - oldOcc;

                    currentCounts[oldKey]--; 
                    currentCounts[targetKey]++;

                    const vAfter = limit - currentCounts[targetKey];
                    const oldVAfter = oldLimit - currentCounts[oldKey];

                    const dispPrefix = displacementImminent ? "INVOLUNTARY AWARD: " : "";

                    p.prefHistory[pr.order] = { 
                        status: "Awarded", 
                        reason: `${dispPrefix}Open position available. Vacancy in ${targetKey} ${vBefore}->${vAfter}. Vacated ${oldKey} ${oldV}->${oldVAfter}${bplLog}` 
                    };

                    auditTrail.push({
                        loop: loops, sen: p.sen, name: p.name, 
                        from: oldKey, to: targetKey,
                        fromTrans: `${oldV} -> ${oldVAfter}`, toTrans: `${vBefore} -> ${vAfter}`
                    });
                    
                    p.currentKey = targetKey;
                    p.moved = true;
                    cascade = true; 
                    break; 
                } else {
                    p.prefHistory[pr.order] = { status: "Denied", reason: `Requested position has ${vBefore} vacancy.` };
                }
            }
            if (cascade) break; 
        }
    }
    return { roster: bidders, loops, auditTrail };
}
