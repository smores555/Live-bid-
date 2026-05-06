// --- CONFIGURATION ---
const CONFIG = {
    username: "YOUR_GITHUB_USERNAME", // Update this
    repo: "YOUR_REPO_NAME",           // Update this
    branch: "main"
};

const BASE_URL = `https://raw.githubusercontent.com/${CONFIG.username}/${CONFIG.repo}/${CONFIG.branch}/`;

let state = {
    roster: [],
    retired: new Set(),
    noBid: new Set(),
    prefs: {},
    positions: {},
    pilots: []
};

// 1. AUTO-FETCH ON LOAD
window.onload = async () => {
    try {
        const [roster, retired, noBid, prefs] = await Promise.all([
            fetch(BASE_URL + 'roster%20(2).json').then(r => r.json()),
            fetch(BASE_URL + 'retired_pilots%20(2).json').then(r => r.json()),
            fetch(BASE_URL + 'nobidpilots%20(2).json').then(r => r.json()),
            fetch(BASE_URL + 'preferences%20(4).json').then(r => r.json())
        ]);

        state.roster = roster;
        state.retired = new Set(retired.map(p => p.sen));
        state.noBid = new Set(noBid.map(p => p.sen));
        state.prefs = prefs;

        initPositions();
    } catch (err) {
        console.error("Failed to fetch data:", err);
        document.getElementById('cap-body').innerHTML = `<tr><td colspan="5" style="color:red">Error loading data. Check CONFIG or GitHub URL.</td></tr>`;
    }
};

function initPositions() {
    state.positions = {};
    state.pilots = [];

    state.roster.forEach(p => {
        // Skip No-Bid Pilots entirely
        if (state.noBid.has(p.sen)) return;

        const posKey = `${p.current.equip} ${p.current.base} ${p.current.seat}`;
        
        if (!state.positions[posKey]) {
            state.positions[posKey] = { current: 0, retiring: 0, target: 0, holding: [] };
        }

        // Retired pilots open vacancies but don't stay in the active pilot pool
        if (state.retired.has(p.sen)) {
            state.positions[posKey].retiring++;
            return;
        }

        // Active Pilots
        state.positions[posKey].current++;
        state.positions[posKey].target++; // Initial default
        
        let pilotPrefs = state.prefs[`pil${p.sen}`]?.preferences || [];
        
        state.pilots.push({
            sen: p.sen,
            name: p.name,
            originalPos: posKey,
            awardedPos: posKey,
            prefs: pilotPrefs.filter(pr => pr.bid).map(pr => ({
                bid: pr.bid,
                bpl: pr.bpl_min || 999
            }))
        });
    });

    renderCapTable();
}

function renderCapTable() {
    const tbody = document.getElementById('cap-body');
    tbody.innerHTML = '';
    
    Object.keys(state.positions).sort().forEach(key => {
        const pos = state.positions[key];
        const delta = pos.target - (pos.current - pos.retiring);
        
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${key}</td>
            <td>${pos.current}</td>
            <td>${pos.retiring}</td>
            <td><input type="number" class="cap-input" value="${pos.target}" onchange="updateCap('${key}', this.value)"></td>
            <td style="color:${delta < 0 ? 'red' : 'green'}">${delta > 0 ? '+' + delta : delta}</td>
        `;
        tbody.appendChild(tr);
    });
}

function updateCap(key, val) {
    state.positions[key].target = parseInt(val);
    renderCapTable();
}

// 2. THE ENGINE
function runBid() {
    // Reset positions "holding" lists
    Object.keys(state.positions).forEach(k => state.positions[k].holding = []);
    
    // Sort pilots by Seniority (1 is most senior)
    state.pilots.sort((a, b) => a.sen - b.sen);

    // Initial Displacements
    // If target < (current - retiring), the junior pilots in that base are kicked out
    Object.keys(state.positions).forEach(key => {
        const pos = state.positions[key];
        const initialHolders = state.pilots.filter(p => p.originalPos === key);
        const capacity = pos.target;

        if (initialHolders.length > capacity) {
            // Sort junior to senior to displace from bottom
            initialHolders.sort((a, b) => b.sen - a.sen);
            const displacedCount = initialHolders.length - capacity;
            for (let i = 0; i < displacedCount; i++) {
                initialHolders[i].awardedPos = null; 
            }
        }
        
        // Those not nullified are initially "holding" their spot
        initialHolders.forEach(p => {
            if (p.awardedPos) pos.holding.push(p);
        });
    });

    // Main Loop: Honors Knock-on Effects
    let changed = true;
    while (changed) {
        changed = false;
        
        for (let i = 0; i < state.pilots.length; i++) {
            const pilot = state.pilots[i];
            const currentAward = pilot.awardedPos;

            for (const pref of pilot.prefs) {
                if (pref.bid === currentAward) break; // Already has it or better

                const targetPos = state.positions[pref.bid];
                if (!targetPos) continue;

                // Rule: Must be a vacancy
                const hasVacancy = targetPos.holding.length < targetPos.target;
                
                // Rule: BPL Check
                // Your BPL rank = (Number of senior pilots currently holding) + 1
                const myBPLRank = targetPos.holding.filter(p => p.sen < pilot.sen).length + 1;
                const passesBPL = myBPLRank <= pref.bpl;

                if (hasVacancy && passesBPL) {
                    // Remove from old
                    if (pilot.awardedPos) {
                        const oldPos = state.positions[pilot.awardedPos];
                        oldPos.holding = oldPos.holding.filter(p => p.sen !== pilot.sen);
                    }
                    
                    // Award New
                    pilot.awardedPos = pref.bid;
                    targetPos.holding.push(pilot);
                    
                    changed = true;
                    break; // Exit pilot loop
                }
            }
            if (changed) break; // Restart from Pilot #1
        }
    }
    renderResults();
}

function renderResults() {
    const area = document.getElementById('results-area');
    const tbody = document.getElementById('results-body');
    area.style.display = 'block';
    tbody.innerHTML = '';

    state.pilots.forEach(p => {
        let statusClass = '';
        let statusText = 'Held';

        if (!p.awardedPos) {
            statusClass = 'displaced';
            statusText = 'DISPLACED';
        } else if (p.awardedPos !== p.originalPos) {
            statusClass = 'moved';
            statusText = 'Awarded';
        }

        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${p.sen}</td>
            <td>${p.name}</td>
            <td>${p.originalPos}</td>
            <td><strong>${p.awardedPos || 'UNASSIGNED'}</strong></td>
            <td><span class="status-badge ${statusClass}">${statusText}</span></td>
        `;
        tbody.appendChild(tr);
    });
}
