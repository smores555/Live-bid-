const GITHUB_BASE = "https://raw.githubusercontent.com/cmalacrea/Bid-Visibility-Tool/main/";

const FILES = {
    roster: "roster%20(2).json",
    retired: "retired_pilots%20(2).json",
    prefs: "preferences%20(4).json",
    nobid: "nobidpilots%20(2).json",
    caps: "capacities%20(4).json"
};

let rawData = {};
let engineState = {
    pilots: [],
    positions: {} // Keyed by "BASE SEAT"
};

// 1. AUTO-FETCH DATA
window.onload = async () => {
    const status = document.getElementById('load-status');
    try {
        const fetchJson = (file) => fetch(GITHUB_BASE + file).then(r => r.json());
        
        const [roster, retired, prefs, nobid, caps] = await Promise.all([
            fetchJson(FILES.roster),
            fetchJson(FILES.retired),
            fetchJson(FILES.prefs),
            fetchJson(FILES.nobid),
            fetchJson(FILES.caps)
        ]);

        rawData = { roster, retired, prefs, nobid, caps };
        status.innerText = "🟢 Data Synced";
        status.style.color = "green";
        
        initializeEngine();
    } catch (e) {
        console.error(e);
        status.innerText = "🔴 Sync Error";
        status.style.color = "red";
    }
};

function initializeEngine() {
    const noBidSens = new Set(rawData.nobid.map(p => p.sen));
    const retiredSens = new Set(rawData.retired.map(p => p.sen));
    
    engineState.positions = {};
    engineState.pilots = [];

    // Setup initial position capacities
    rawData.caps.forEach(c => {
        const key = `${c.base} ${c.seat}`;
        engineState.positions[key] = {
            currentCount: 0,
            target: c.startCapacity + c.delta,
            holding: [] // Current active pilots
        };
    });

    // Clean Roster & Assign initial holders
    rawData.roster.forEach(p => {
        if (noBidSens.has(p.sen) || retiredSens.has(p.sen)) return;

        const posKey = `${p.current.base} ${p.current.seat}`;
        const pilotPrefs = rawData.prefs[`pil${p.sen}`]?.preferences || [];

        const pilotObj = {
            sen: p.sen,
            name: p.name,
            originalPos: posKey,
            awardedPos: posKey,
            displaced: false,
            preferences: pilotPrefs
                .filter(pr => pr.bid && pr.bid.trim() !== "")
                .map(pr => ({
                    // Normalize "73G SEA FO" to "SEA FO"
                    bid: pr.bid.split(' ').filter(word => word.length === 3 || word === "CA" || word === "FO").join(' ').replace('73G ','').replace('737 ',''),
                    bpl: pr.bpl_min || 0
                }))
        };

        engineState.pilots.push(pilotObj);
        
        if (engineState.positions[posKey]) {
            engineState.positions[posKey].currentCount++;
            engineState.positions[posKey].holding.push(pilotObj);
        }
    });

    renderCapTable();
}

function renderCapTable() {
    const body = document.getElementById('cap-body');
    body.innerHTML = '';
    Object.keys(engineState.positions).sort().forEach(key => {
        const pos = engineState.positions[key];
        body.innerHTML += `
            <tr>
                <td><strong>${key}</strong></td>
                <td>${pos.currentCount}</td>
                <td><input type="number" class="cap-input" value="${pos.target}" onchange="updateLocalCap('${key}', this.value)"></td>
            </tr>
        `;
    });
}

function updateLocalCap(key, val) {
    engineState.positions[key].target = parseInt(val);
}

// 2. THE ENGINE LOGIC
function runBid() {
    const pilots = engineState.pilots;
    const positions = engineState.positions;

    // Reset holding lists for a fresh run
    Object.keys(positions).forEach(k => positions[k].holding = []);

    // Step A: Handle Initial Displacements (Junior out first)
    Object.keys(positions).forEach(key => {
        const pos = positions[key];
        const initialHolders = pilots.filter(p => p.originalPos === key);
        
        // Sort junior to senior (highest number = most junior)
        initialHolders.sort((a,b) => b.sen - a.sen);
        
        const countToDisplace = initialHolders.length - pos.target;
        for (let i = 0; i < countToDisplace; i++) {
            if (initialHolders[i]) {
                initialHolders[i].awardedPos = null;
                initialHolders[i].displaced = true;
            }
        }

        // Everyone else "holds" their current spot initially
        initialHolders.forEach(p => {
            if (p.awardedPos) {
                pos.holding.push(p);
                p.displaced = false;
            }
        });
    });

    // Step B: Seniority Bidding with Restart Logic
    let awardMade = true;
    while (awardMade) {
        awardMade = false;
        pilots.sort((a, b) => a.sen - b.sen); // Seniority Order

        for (let i = 0; i < pilots.length; i++) {
            const pilot = pilots[i];
            const currentAward = pilot.awardedPos;

            for (const pref of pilot.preferences) {
                // If they already hold this or better, stop checking lower prefs
                if (pref.bid === currentAward) break;

                const targetPos = positions[pref.bid];
                if (!targetPos) continue;

                // 1. Vacancy Check
                const hasRoom = targetPos.holding.length < targetPos.target;

                // 2. BPL Check (Rank = Senior pilots already there + 1)
                const currentRank = targetPos.holding.filter(p => p.sen < pilot.sen).length + 1;
                const passesBPL = pref.bpl === 0 || currentRank <= pref.bpl;

                if (hasRoom && passesBPL) {
                    // Release old spot
                    if (pilot.awardedPos) {
                        const oldKey = pilot.awardedPos;
                        positions[oldKey].holding = positions[oldKey].holding.filter(p => p.sen !== pilot.sen);
                    }

                    // Award New Spot
                    pilot.awardedPos = pref.bid;
                    pilot.displaced = false;
                    targetPos.holding.push(pilot);
                    
                    awardMade = true;
                    break; // Found an award, restart from Pilot #1
                }
            }
            if (awardMade) break; // Break pilot loop to restart while(awardMade)
        }
    }

    renderResults();
}

function renderResults() {
    const tbody = document.getElementById('results-body');
    tbody.innerHTML = '';
    
    engineState.pilots.sort((a,b) => a.sen - b.sen).forEach(p => {
        let statusClass = 'held';
        let statusText = 'Held';
        
        if (p.displaced && !p.awardedPos) {
            statusClass = 'displaced';
            statusText = 'Displaced';
        } else if (p.awardedPos !== p.originalPos) {
            statusClass = 'moved';
            statusText = 'Awarded';
        }

        // Calculate final BPL rank for display
        const finalRank = p.awardedPos ? 
            engineState.positions[p.awardedPos].holding.filter(h => h.sen < p.sen).length + 1 : '-';

        tbody.innerHTML += `
            <tr>
                <td>${p.sen}</td>
                <td>${p.name}</td>
                <td>${p.originalPos}</td>
                <td><strong>${p.awardedPos || 'UNASSIGNED'}</strong></td>
                <td>${finalRank}</td>
                <td><span class="status ${statusClass}">${statusText}</span></td>
            </tr>
        `;
    });
}
