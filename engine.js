/**
 * AIRLINE BID ENGINE - Fleet-Aware Logic
 * Fixes: Overcounting by separating 737 and 320 buckets in the rank.
 */
function runBidEngine(data, deltaMap, trackSen = null) {
    const auditTrail = [];
    const retiredSens = new Set(data.retired.map(p => p.seniority));
    const noBidSens = new Set(data.noBid.map(p => p.sen));

    // 1. Initialize Counts and Pilot Fleet Mapping
    let currentCounts = {};
    data.caps.forEach(c => currentCounts[`${c.base}-${c.seat}`] = 0);

    const noBidOccupants = {};
    data.noBid.forEach(p => {
        // Extract fleet from the bid/seat if possible, else default to "737"
        const fleet = p.fleet || (p.seat && p.seat.includes('320') ? '320' : '737');
        const key = `${p.base}-${p.seat}`;
        noBidOccupants[p.sen] = { key, fleet };
        currentCounts[key] = (currentCounts[key] || 0) + 1;
    });

    const rosterMap = new Map();
    data.roster.forEach(p => { if (!rosterMap.has(p.sen)) rosterMap.set(p.sen, p); });

    const bidders = Array.from(rosterMap.values())
        .filter(p => !retiredSens.has(p.sen) && !noBidSens.has(p.sen))
        .map(p => {
            const key = `${p.current.base}-${p.current.seat}`;
            currentCounts[key] = (currentCounts[key] || 0) + 1;
            
            // Map preferences
            const prefData = data.prefs['pil' + p.sen] || data.prefs[p.id] || { preferences: [] };
            
            // Determine Pilot's Fleet from their first bid if not in roster
            let pilotFleet = p.fleet;
            if (!pilotFleet && prefData.preferences.length > 0) {
                const firstBid = prefData.preferences[0].bid || "";
                pilotFleet = firstBid.split(/\s+/)[0]; // e.g., "73G" or "737"
            }
            if (!pilotFleet) pilotFleet = "737"; // Default fallback

            return {
                ...p, currentKey: key, orig: key, moved: false, fleet: pilotFleet,
                prefHistory: {}, 
                prefs: (prefData.preferences || []).sort((a, b) => a.order - b.order)
            };
        }).sort((a, b) => a.sen - b.sen);

    // 2. Set Targets
    let targetMap = {};
    for (let key in currentCounts) {
        targetMap[key] = currentCounts[key] + (deltaMap[key] || 0);
    }

    let cascade = true;
    let loops = 0;

    // 3. Cascade Loop
    while (cascade) {
        cascade = false;
        loops++;
        for (let i = 0; i < bidders.length; i++) {
            const p = bidders[i];
            
            for (const pr of p.prefs) {
                if (!pr.bid) continue;
                const parts = pr.bid.trim().split(/\s+/);
                if (parts.length < 3) continue;
                
                const bidFleet = parts[0];
                const targetBaseSeat = `${parts[1]}-${parts[2]}`;
                
                // --- RANK CALCULATION (FLEET FILTERED) ---
                // Only count pilots senior to 'p' who are in the SAME Base/Seat AND SAME Fleet
                let rank = 1;
                for (const other of bidders) {
                    if (other.sen >= p.sen) break;
                    // Check if other pilot is in the target position and shares the fleet
                    if (other.currentKey === targetBaseSeat && (other.fleet === bidFleet || other.fleet === p.fleet)) rank++;
                }
                for (let sen in noBidOccupants) {
                    const nb = noBidOccupants[sen];
                    if (parseInt(sen) < p.sen && nb.key === targetBaseSeat && (nb.fleet === bidFleet || nb.fleet === p.fleet)) rank++;
                }

                const reqBPL = parseInt(pr.bpl_min) || 0;
                const bplInfo = `. Requested BPL = ${reqBPL}. BPL at time of award = ${rank}.`;

                // BPL CHECK
                if (reqBPL > 0 && rank > reqBPL) {
                    p.prefHistory[pr.order] = { status: "Denied", reason: `Bid request does not meet BPL requirement${bplInfo}` };
                    continue; 
                }

                // REMAIN IN POSITION
                if (targetBaseSeat === p.currentKey) {
                    p.prefHistory[pr.order] = { status: "Awarded", reason: `Remain in current position${bplInfo}` };
                    break;
                }

                // CAPACITY CHECK
                const currentOcc = currentCounts[targetBaseSeat] || 0;
                const limit = targetMap[targetBaseSeat] || 0;
                const targetVacancies = limit - currentOcc;

                if (currentOcc < limit) {
                    const oldBase = p.currentKey;
                    const oldVacancies = (targetMap[oldBase] || 0) - currentCounts[oldBase];

                    currentCounts[oldBase]--; 
                    currentCounts[targetBaseSeat]++;

                    p.prefHistory[pr.order] = { 
                        status: "Awarded", 
                        reason: `Open position available. Reduce vacancy in ${targetBaseSeat} from ${targetVacancies} to ${targetVacancies - 1}. Increase vacancy in ${oldBase} from ${oldVacancies} to ${oldVacancies + 1}${bplInfo}` 
                    };

                    auditTrail.push({
                        loop: loops, sen: p.sen, name: p.name, 
                        from: oldBase, to: targetBaseSeat
                    });
                    
                    p.currentKey = targetBaseSeat;
                    p.moved = true;
                    cascade = true; 
                    break; 
                } else {
                    p.prefHistory[pr.order] = { status: "Denied", reason: `Requested position has ${targetVacancies} vacancy and cannot accept additional pilots.` };
                }
            }
            if (cascade) break; 
        }
        if (loops > 10000) break;
    }
    return { roster: bidders, loops, auditTrail };
}
