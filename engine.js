/**
 * THE 737 ADMIN ENGINE - BPL COMPLIANT (STRICT DISPLACEMENT)
 */
function runBidEngine(data, deltaMap) {
    const auditTrail = [];
    const is737 = (seat) => seat && !seat.includes('320') && !seat.includes('321');

    const retiredSens = new Set(data.retired.filter(p => is737(p.seat)).map(p => p.seniority));
    const noBidSens = new Set(data.noBid.filter(p => is737(p.seat)).map(p => p.sen));

    // 1. Initialize Target Capacities (Hard Cap + User Delta)
    let targetMap = {};
    data.caps.forEach(c => {
        const key = `${c.base}-${c.seat}`;
        targetMap[key] = c.startCapacity + (deltaMap[key] || 0);
    });

    // 2. Prepare Bidders
    let currentCounts = {};
    const bidders = data.roster
        .filter(p => is737(p.current.seat) && !retiredSens.has(p.sen) && !noBidSens.has(p.sen))
        .map(p => {
            const key = `${p.current.base}-${p.current.seat}`;
            currentCounts[key] = (currentCounts[key] || 0) + 1;
            const prefData = data.prefs['pil' + p.sen] || data.prefs[p.id] || { preferences: [] };
            return {
                ...p, currentKey: key, orig: key, moved: false, wasDisplaced: false, isUnassigned: false,
                awardedPrefNum: "N/A", awardedReason: "Holding Seniority",
                prefs: (prefData.preferences || []).sort((a, b) => a.order - b.order)
            };
        }).sort((a, b) => a.sen - b.sen);

    // 3. Execution Cascade
    let cascade = true; 
    let loops = 0;
    
    while (cascade) {
        cascade = false; 
        loops++; 
        if (loops > 5000) break; // Infinite loop protection

        for (let i = 0; i < bidders.length; i++) {
            const p = bidders[i];
            
            // STAGE 1: MANDATORY EVICTION (The "Seth" Rule)
            // If the pilot is in a seat, check if they are senior enough to stay.
            if (p.currentKey !== "UNASSIGNED") {
                let rankInCurrent = 1;
                bidders.forEach(other => { 
                    if (other.sen < p.sen && other.currentKey === p.currentKey) rankInCurrent++; 
                });
                
                const limit = targetMap[p.currentKey] || 0;
                if (rankInCurrent > limit) {
                    const oldKey = p.currentKey;
                    currentCounts[oldKey]--;
                    p.currentKey = "UNASSIGNED";
                    p.wasDisplaced = true;
                    p.awardedReason = "Displaced (Over Capacity)";
                    p.awardedPrefNum = "N/A";
                    auditTrail.push({ loop: loops, sen: p.sen, name: p.name, from: oldKey, to: "UNASSIGNED", type: "Eviction" });
                    cascade = true;
                    continue; // Skip to next pilot to let the displacement ripple
                }
            }

            // STAGE 2: PREFERENCE EVALUATION
            // Only triggers if they are UNASSIGNED (either evicted or moved)
            if (p.currentKey === "UNASSIGNED") {
                let foundAward = false;
                for (const pr of p.prefs) {
                    if (!pr.bid || pr.bid === "0") continue;
                    const parts = pr.bid.trim().split(/\s+/);
                    let targetKey = (parts.length === 2) ? `${parts[1]}-${parts[0]}` : `${parts[1]}-${parts[2]}`;
                    
                    let rankInTarget = 1;
                    let targetOcc = 0;
                    bidders.forEach(other => {
                        if (other.currentKey === targetKey) targetOcc++;
                        if (other.sen < p.sen && other.currentKey === targetKey) rankInTarget++;
                    });

                    const limit = targetMap[targetKey] || 0;

                    // Strictly Awarded based on seniority limit
                    if (rankInTarget <= limit) {
                        p.currentKey = targetKey;
                        p.moved = true;
                        p.awardedPrefNum = pr.order;
                        p.awardedReason = (targetOcc < limit) ? "Vacancy Award" : "Seniority Bump";
                        currentCounts[targetKey]++;
                        auditTrail.push({ loop: loops, sen: p.sen, name: p.name, from: "UNASSIGNED", to: targetKey, type: "Award" });
                        cascade = true;
                        foundAward = true;
                        break;
                    }
                }

                // STAGE 3: CATEGORY SWEEP (Fallback for displaced pilots)
                if (!foundAward) {
                    const seatType = p.current.seat;
                    for (let key in targetMap) {
                        if (key.endsWith(`-${seatType}`)) {
                            let occ = bidders.filter(b => b.currentKey === key).length;
                            if (occ < targetMap[key]) {
                                p.currentKey = key; 
                                p.moved = true; 
                                cascade = true; 
                                foundAward = true;
                                p.awardedPrefNum = "Sweep"; 
                                p.awardedReason = `${seatType} Category Vacancy`;
                                currentCounts[key]++;
                                auditTrail.push({ loop: loops, sen: p.sen, name: p.name, from: "UNASSIGNED", to: key, type: "Sweep" });
                                break;
                            }
                        }
                    }
                }

                // STAGE 4: FINAL DISPLACEMENT (At Mercy)
                if (!foundAward) {
                    p.isUnassigned = true; 
                    p.awardedReason = "At Mercy of Company";
                    p.awardedPrefNum = "Pool";
                }
            }
            if (cascade) break; // Restart pass whenever a seat changes
        }
    }
    return { roster: bidders, loops, auditTrail, targetMap };
}
