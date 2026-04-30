/**
 * AIRLINE CASCADING BID ENGINE
 * Logic: Restart from Pilot #1 on every award.
 * BPL: Restricted by seniority rank within the target position.
 */

function runBidEngine(data, capacities, trackSen = null) {
    const logs = [];
    const trace = [];
    
    // 1. Filter out "Ghost Pilots" (Retired/No-Bid)
    // They don't count toward capacity, vacancies, or bidding.
    const retiredSet = new Set(data.retired.map(p => p.seniority));
    const noBidSet = new Set(data.noBid.map(p => p.sen));

    // 2. Initialize Current Counts based on Active Roster only
    let counts = {};
    let activePilots = data.roster
        .filter(p => !retiredSet.has(p.sen) && !noBidSet.has(p.sen))
        .map(p => {
            const key = `${p.current.base}-${p.current.seat}`;
            counts[key] = (counts[key] || 0) + 1;
            return {
                ...p,
                orig: key,
                currentKey: key,
                moved: false,
                // Sort preferences by order (1, 2, 3...)
                prefs: (data.prefs[p.id]?.preferences || []).sort((a, b) => a.order - b.order)
            };
        });

    // 3. Sort by Seniority (1 is most senior)
    activePilots.sort((a, b) => a.sen - b.sen);

    let cascade = true;
    let loops = 0;

    while (cascade) {
        cascade = false;
        loops++;

        for (let i = 0; i < activePilots.length; i++) {
            const p = activePilots[i];
            
            for (const pr of p.prefs) {
                if (!pr.bid) continue;
                // Format: "1 SEA CA" -> "SEA-CA"
                const targetKey = pr.bid.split(" ").slice(1).join("-");

                // If they are already in their preferred spot, skip to next pref
                if (targetKey === p.currentKey) break;

                // Check Capacity
                const currentOccupancy = counts[targetKey] || 0;
                const maxCapacity = capacities[targetKey] || 0;

                let logContext = `Sen ${p.sen} | Pref ${pr.order}: ${pr.bid}`;

                if (currentOccupancy < maxCapacity) {
                    // 4. BPL Logic Check:
                    // Rank is determined by how many pilots (including more senior ones)
                    // are currently occupying that target position.
                    let rankAtTarget = 1;
                    for (let j = 0; j < activePilots.length; j++) {
                        if (activePilots[j].currentKey === targetKey) {
                            rankAtTarget++;
                        }
                    }

                    // If BPL is 5, you must be Rank 1, 2, 3, 4, or 5.
                    if (pr.bpl_min > 0 && rankAtTarget > pr.bpl_min) {
                        if (p.sen === trackSen) {
                            trace.push({ status: 'fail', msg: `${logContext} | REJECTED: BPL ${pr.bpl_min} exceeded (Your Rank: ${rankAtTarget})` });
                        }
                        continue;
                    }

                    // AWARD GRANTED
                    if (p.sen === trackSen) {
                        trace.push({ status: 'success', msg: `${logContext} | AWARDED! (New Rank: ${rankAtTarget})` });
                    }

                    // Update counts & vacate old spot
                    counts[p.currentKey]--;
                    counts[targetKey] = (counts[targetKey] || 0) + 1;
                    
                    logs.push({ 
                        loop: loops, sen: p.sen, name: p.name, 
                        from: p.currentKey, to: targetKey 
                    });

                    p.currentKey = targetKey;
                    p.moved = true;
                    
                    // CASCADING RESTART: 
                    // Set cascade to true and BREAK out of ALL loops to start back at Pilot #1
                    cascade = true;
                    break;
                } else {
                    if (p.sen === trackSen) {
                        trace.push({ status: 'fail', msg: `${logContext} | REJECTED: Cap Full (${currentOccupancy}/${maxCapacity})` });
                    }
                }
            }
            if (cascade) break; // Break pilot loop to restart while loop
        }
    }

    return { roster: activePilots, logs, trace, loops };
}
