// app.js

document.getElementById('runBidBtn').addEventListener('click', async () => {
    document.getElementById('loading').classList.remove('hidden');
    document.getElementById('resultsTable').classList.add('hidden');

    try {
        // 1. Fetch all JSON files (Ensure these files are in the same folder as index.html)
        const [rosterRes, prefsRes, capsRes, retiredRes, noBidRes] = await Promise.all([
            fetch('roster.json'),
            fetch('preferences.json'),
            fetch('capacities.json'),
            fetch('retired_pilots.json'),
            fetch('nobidpilots.json')
        ]);

        const roster = await rosterRes.json();
        const preferences = await prefsRes.json();
        const capacities = await capsRes.json();
        const retired = await retiredRes.json();
        const noBids = await noBidRes.json();

        // 2. Run the Engine
        const awardedRoster = runBidSimulation(roster, preferences, capacities, retired, noBids);

        // 3. Render Results
        renderTable(awardedRoster);

    } catch (error) {
        console.error("Error loading files:", error);
        alert("Failed to load JSON files. Make sure they are named correctly and in the same folder.");
    } finally {
        document.getElementById('loading').classList.add('hidden');
    }
});

function runBidSimulation(roster, preferences, capacities, retired, noBids) {
    console.log("Starting Bid Simulation...");

    // Create sets of seniority numbers for fast exclusion checking
    const retiredSen = new Set(retired.map(p => p.seniority));
    const noBidSen = new Set(noBids.map(p => p.sen));

    let activePilots = [];
    let currentCounts = {};
    let targetCapacities = {};

    // Initialize capacities (Current active pilots allowed = startCapacity + delta)
    capacities.forEach(cap => {
        const key = `${cap.base}-${cap.seat}`;
        targetCapacities[key] = cap.startCapacity + cap.delta;
        currentCounts[key] = 0;
    });

    // Filter Roster and set up initial counts
    roster.forEach(pilot => {
        // Only include if NOT retired and NOT on no-bid list
        if (!retiredSen.has(pilot.sen) && !noBidSen.has(pilot.sen)) {
            let pilotPrefs = preferences[pilot.id] ? preferences[pilot.id].preferences : [];
            // Sort by their preferred order
            pilotPrefs.sort((a, b) => a.order - b.order);
            
            // Track their starting position to see if they move later
            let startKey = `${pilot.current.base}-${pilot.current.seat}`;

            activePilots.push({
                ...pilot,
                prefs: pilotPrefs,
                originalBaseSeat: startKey,
                moved: false
            });

            // Count them in their current base
            if (currentCounts[startKey] !== undefined) {
                currentCounts[startKey]++;
            } else {
                currentCounts[startKey] = 1;
            }
        }
    });

    // Sort active pilots by seniority (1 is highest)
    activePilots.sort((a, b) => a.sen - b.sen);

    let stateChanged = true;

    // The Cascading Loop
    while (stateChanged) {
        stateChanged = false;

        for (let i = 0; i < activePilots.length; i++) {
            let pilot = activePilots[i];
            let currentKey = `${pilot.current.base}-${pilot.current.seat}`;

            for (let pref of pilot.prefs) {
                if (!pref.bid || pref.bid === "") continue;

                // Example pref.bid: "73G SFO FO" -> We just need Base and Seat
                let parts = pref.bid.split(" ");
                if (parts.length < 3) continue;
                let targetKey = `${parts[1]}-${parts[2]}`; // e.g., "SFO-FO"

                // Skip if they are already in this base/seat
                if (targetKey === currentKey) break; // They hold a higher pref already

                let targetCap = targetCapacities[targetKey] || 0;
                let currentActiveInTarget = currentCounts[targetKey] || 0;

                // Is there room?
                if (currentActiveInTarget < targetCap) {
                    
                    // Check BPL (Base Position List)
                    let meetsBPL = true;
                    if (pref.bpl_min > 0) {
                        let rankInNewBase = 1;
                        for (let p of activePilots) {
                            if (p.sen < pilot.sen && `${p.current.base}-${p.current.seat}` === targetKey) {
                                rankInNewBase++;
                            }
                        }
                        // If rank is higher than their required minimum, they don't get it
                        if (rankInNewBase > pref.bpl_min) {
                            meetsBPL = false;
                        }
                    }

                    // Award the Bid
                    if (meetsBPL) {
                        // Create vacancy in old base, fill in new base
                        if(currentCounts[currentKey] !== undefined) currentCounts[currentKey]--;
                        currentCounts[targetKey]++;

                        pilot.current.base = parts[1];
                        pilot.current.seat = parts[2];
                        pilot.moved = true;

                        stateChanged = true; // Trigger restart of the cascade!
                        break; 
                    }
                }
            }
            if (stateChanged) break; // Restart loop from Sen #1
        }
    }

    return activePilots;
}

function renderTable(pilots) {
    const tbody = document.getElementById('resultsBody');
    tbody.innerHTML = ""; // Clear existing rows

    pilots.forEach(pilot => {
        const tr = document.createElement('tr');
        const currentBaseSeat = `${pilot.current.base} ${pilot.current.seat}`;
        
        tr.innerHTML = `
            <td>${pilot.sen}</td>
            <td>${pilot.name}</td>
            <td>${pilot.originalBaseSeat.replace('-', ' ')}</td>
            <td class="${pilot.moved ? 'moved' : 'stayed'}">${currentBaseSeat}</td>
            <td class="${pilot.moved ? 'moved' : 'stayed'}">${pilot.moved ? 'AWARDED' : 'HELD'}</td>
        `;
        tbody.appendChild(tr);
    });

    document.getElementById('resultsTable').classList.remove('hidden');
}
