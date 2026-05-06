// This map tells the engine which files to look for. 
// It will try the first name, and if it fails, it will try the second.
const FILE_MAP = {
    roster: ["roster (2).json", "roster.json"],
    retired: ["retired_pilots (2).json", "retired_pilots.json"],
    prefs: ["preferences (4).json", "preferences.json"],
    nobid: ["nobidpilots (2).json", "nobidpilots.json"],
    caps: ["capacities (4).json", "capacities.json"]
};

let state = {
    pilots: [],
    positions: {},
    raw: {}
};

// --- DATA LOADING WITH AUTO-RETRY ---
window.onload = async () => {
    const status = document.getElementById('load-status');
    
    try {
        const fetchWithRetry = async (key) => {
            const names = FILE_MAP[key];
            for (let name of names) {
                try {
                    const response = await fetch(`./${encodeURIComponent(name)}`);
                    if (response.ok) return await response.json();
                } catch (e) { /* continue to next name */ }
            }
            throw new Error(`Could not find ${key} file (tried: ${names.join(', ')})`);
        };

        const [roster, retired, prefs, nobid, caps] = await Promise.all([
            fetchWithRetry('roster'),
            fetchWithRetry('retired'),
            fetchWithRetry('prefs'),
            fetchWithRetry('nobid'),
            fetchWithRetry('caps')
        ]);

        state.raw = { roster, retired, prefs, nobid, caps };
        status.innerText = "🟢 Data Loaded Successfully";
        status.style.color = "#16a34a";
        
        setupEngine();
    } catch (err) {
        console.error(err);
        status.innerText = `🔴 ${err.message}`;
        status.style.color = "#dc2626";
    }
};

function setupEngine() {
    const noBidSens = new Set(state.raw.nobid.map(p => p.sen));
    const retiredSens = new Set(state.raw.retired.map(p => p.sen));
    
    state.positions = {};
    state.pilots = [];

    // 1. Initialize Positions from Capacities (Target = Start + Delta)
    state.raw.caps.forEach(c => {
        const key = `${c.base} ${c.seat}`;
        state.positions[key] = {
            currentCount: 0,
            target: (c.startCapacity || 0) + (c.delta || 0),
            holding: [] 
        };
    });

    // 2. Build Active Pilot List (Skip No-Bids & Retired)
    state.raw.roster.forEach(p => {
        if (noBidSens.has(p.sen) || retiredSens.has(p.sen)) return;

        const posKey = `${p.current.base} ${p.current.seat}`;
        const pPrefData = state.raw.prefs[`pil${p.sen}`] || state.raw.prefs[p.id];
        
        const pilot = {
            sen: p.sen,
            name: p.name,
            originalPos: posKey,
            awardedPos: posKey,
            preferences: (pPrefData?.preferences || [])
                .filter(pr => pr.bid && pr.bid.trim() !== "")
                .map(pr => ({
                    // Cleans prefixes like "73G " or "737 " to match the "BASE SEAT" keys
                    bid: pr.bid.replace(/73G |737 /g, '').trim(),
                    bpl: pr.bpl_min || 0
                }))
        };

        state.pilots.push(pilot);
        if (state.positions[posKey]) {
            state.positions[posKey].currentCount++;
            state.positions[posKey].holding.push(pilot);
        }
    });

    renderCapTable();
}

function renderCapTable() {
    const body = document.getElementById('cap-body');
    body.innerHTML = '';
    Object.keys(state.positions).sort().forEach(key => {
        const pos = state.positions[key];
        body.innerHTML += `
            <tr>
                <td><strong>${key}</strong></td>
                <td>${pos.currentCount}</td>
                <td><input type="number" class="cap-input" value="${pos.target}" onchange="updateCap('${key}', this.value)"></td>
            </tr>
        `;
    });
}

function updateCap(key, val) {
    state.positions[key].target = parseInt(val) || 0;
}

// --- THE RESTART ENGINE ---
function runBid() {
    const pilots = state.pilots;
    const positions = state.positions;

    // Reset positions
    Object.keys(positions).forEach(k => positions[k].holding = []);

    // Step 1: Initial Displacements (Negative Delta logic)
    Object.keys(positions).forEach(key => {
        const pos = positions[key];
        const initialHolders = pilots.filter(p => p.originalPos === key);
        
        // Displace from bottom up (Junior first)
        initialHolders.sort((a,b) => b.sen - a.sen);
        
        const overage = initialHolders.length - pos.target;
        for (let i = 0; i < overage; i++) {
            if (initialHolders[i]) initialHolders[i].awardedPos = null;
        }

        initialHolders.forEach(p => {
            if (p.awardedPos) pos.holding.push(p);
        });
    });

    // Step 2: Main Bid Loop (Restart from #1 on every award)
    let awardMade = true;
    while (awardMade) {
        awardMade = false;
        pilots.sort((a, b) => a.sen - b.sen); // Seniority order

        for (let i = 0; i < pilots.length; i++) {
            const pilot = pilots[i];
            const currentAward = pilot.awardedPos;

            for (const pref of pilot.preferences) {
                if (pref.bid === currentAward) break; // Already has it or better

                const target = positions[pref.bid];
                if (!target) continue;

                // Rule 1: Vacancy must exist
                const hasVacancy = target.holding.length < target.target;
                
                // Rule 2: BPL Check (BPL Rank = senior holders + 1)
                const bplRank = target.holding.filter(p => p.sen < pilot.sen).length + 1;
                const passesBPL = pref.bpl === 0 || bplRank <= pref.bpl;

                if (hasVacancy && passesBPL) {
                    // Update holdings
                    if (pilot.awardedPos) {
                        positions[pilot.awardedPos].holding = positions[pilot.awardedPos].holding.filter(p => p.sen !== pilot.sen);
                    }

                    pilot.awardedPos = pref.bid;
                    target.holding.push(pilot);
                    
                    awardMade = true;
                    break; // Award found! BREAK pilot loop to RESTART from Pilot #1
                }
            }
            if (awardMade) break; 
        }
    }
    renderResults();
}

function renderResults() {
    const tbody = document.getElementById('results-body');
    tbody.innerHTML = '';
    
    state.pilots.sort((a,b) => a.sen - b.sen).forEach(p => {
        let status = p.awardedPos === p.originalPos ? 'held' : 'moved';
        let label = p.awardedPos === p.originalPos ? 'Held' : 'Awarded';
        
        if (!p.awardedPos) {
            status = 'displaced';
            label = 'Displaced';
        }

        const rank = p.awardedPos ? 
            state.positions[p.awardedPos].holding.filter(h => h.sen < p.sen).length + 1 : '-';

        tbody.innerHTML += `
            <tr>
                <td>${p.sen}</td>
                <td>${p.name}</td>
                <td>${p.originalPos}</td>
                <td><strong>${p.awardedPos || 'UNASSIGNED'}</strong></td>
                <td>${rank}</td>
                <td><span class="status ${status}">${label}</span></td>
            </tr>
        `;
    });
}
