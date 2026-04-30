// bid-engine.js

async function runBidSimulation(roster, preferences, capacities, retired, noBids) {
    console.log("Starting Bid Simulation...");

    // 1. Format Exclusions
    const excludedNames = new Set(retired.map(p => p.name));
    const noBidSen = new Set(noBids.map(p => p.sen));

    // 2. Build Active Roster & Current Capacities
    let activePilots = [];
    let currentCounts = {}; // Tracks how many active pilots are in each Base+Seat

    // Initialize counts based on capacities.json targets
    let targetCapacities = {};
    capacities.forEach(cap => {
        const key = `${cap.base}-${cap.seat}`;
        targetCapacities[key] = cap.startCapacity + cap.delta;
        currentCounts[key] = 0; 
    });

    roster.forEach(pilot => {
        // Filter out retired and no-bids
        if (!excludedNames.has(pilot.name) && !noBidSen.has(pilot.sen)) {
            // Attach their preferences
            pilot.prefs = preferences[pilot.id] ? preferences[pilot.id].preferences : [];
            // Sort preferences by order
            pilot.prefs.sort((a, b) => a.order - b.order);
            
            activePilots.push(pilot);

            // Tally current locations of active pilots
            const currentKey = `${pilot.current.base}-${pilot.current.seat}`;
            if (currentCounts[currentKey] !== undefined) {
                currentCounts[currentKey]++;
            } else {
                currentCounts[currentKey] = 1;
            }
        }
    });

    // Sort active pilots by seniority (1 is most senior)
    activePilots.sort((a, b) => a.sen - b.sen);

    // 3. The Cascading Bid Loop
    let stateChanged = true;
    let loopCount = 0;

    // Keep looping until we do a full pass from Sen 1 to the bottom with NO moves
    while (stateChanged) {
        stateChanged = false;
        loopCount++;

        for (let i = 0; i < activePilots.length; i++) {
            let pilot = activePilots[i];
            let currentKey = `${pilot.current.base}-${pilot.current.seat}`;

            // Check their preferences
            for (let pref of pilot.prefs) {
                // Ignore empty bids or their current position
                if (!pref.bid || pref.bid === currentKey) continue;

                // Extract requested Base and Seat (e.g., "73G SFO FO" -> Base: SFO, Seat: FO)
                let parts = pref.bid.split(" ");
                if (parts.length < 3) continue;
                let targetBase = parts[1];
                let targetSeat = parts[2];
                let targetKey = `${targetBase}-${targetSeat}`;

                // Is there a vacancy? (Current active pilots < Target Capacity)
                let targetCap = targetCapacities[targetKey] || 0;
                let currentActiveInTarget = currentCounts[targetKey] || 0;

                if (currentActiveInTarget < targetCap) {
                    
                    // 4. BPL (Base Position List) Check
                    let meetsBPL = true;
                    if (pref.bpl_min > 0) {
                        // Calculate what their rank would be in this new base/seat
                        let rankInNewBase = 1; 
                        for (let p of activePilots) {
                            if (p.sen < pilot.sen && `${p.current.base}-${p.current.seat}` === targetKey) {
                                rankInNewBase++;
                            }
                        }
                        if (rankInNewBase > pref.bpl_min) {
                            meetsBPL = false;
                        }
                    }

                    // If vacancy exists AND BPL is met, award the bid!
                    if (meetsBPL) {
                        console.log(`Awarding ${pilot.name} (Sen: ${pilot.sen}) to ${targetKey}`);
                        
                        // Update counts
                        currentCounts[currentKey]--; // Create vacancy in old base
                        currentCounts[targetKey]++;  // Fill vacancy in new base

                        // Update pilot's current position
                        pilot.current.base = targetBase;
                        pilot.current.seat = targetSeat;

                        // Trigger a restart of the loop!
                        stateChanged = true;
                        break; // Break out of preference loop
                    }
                }
            }

            // If a move was made, break the pilot loop to restart from Seniority 1
            if (stateChanged) break; 
        }
    }

    console.log(`Simulation finished in ${loopCount} cascading loops.`);
    return activePilots; // This is your newly awarded roster!
}
