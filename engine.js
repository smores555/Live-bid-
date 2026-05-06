/**
 * AIRLINE POSITION BID ENGINE - CORE LOGIC
 * Features: 
 * - Seniority-based awarding with Pilot #1 restart for knock-on effects.
 * - BPL (Bid Position List) rank validation.
 * - Displacement handling for negative capacity deltas.
 * - Detailed transaction logging of vacancy changes.
 */

const FILE_MAP = {
    roster: ["roster (2).json", "roster.json"],
    retired: ["retired_pilots (2).json", "retired_pilots.json"],
    prefs: ["preferences (4).json", "preferences.json"],
    nobid: ["nobidpilots (2).json", "nobidpilots.json"],
    caps: ["capacities (4).json", "capacities.json"]
};

let state = {
    pilots: [],
    positions: {}, // Keyed by "BASE SEAT"
    raw: {}
};

// --- HELPERS ---

function formatPosName(posKey) {
    if (!posKey) return "Unassigned";
    const baseMap = { 
        "SEA": "Seattle", "LAX": "Los Angeles", "ANC": "Anchorage", 
        "PDX": "Portland", "SFO": "San Francisco", "SAN": "San Diego" 
    };
    const seatMap = { "CA": "Captain", "FO": "First Officer" };
    const parts = posKey.split(' ');
    const base = baseMap[parts[0]] || parts[0];
    const seat = seatMap[parts[1]] || parts[1];
    return `${base} ${seat}`;
}

function getVacancyCount(posKey) {
    const pos = state.positions[posKey];
    if (!pos) return 0;
    return pos.target - pos.holding.length;
}

// --- DATA LOADING ---

window.onload = async () => {
    const status = document.getElementById('load-status');
    try {
        const fetchWithRetry = async (key) => {
            const names = FILE_MAP[key];
            for (let name of names) {
                try {
                    const response = await fetch(`./${encodeURIComponent(name)}`);
                    if (response.ok) return await response.json();
                } catch (e) {}
            }
            throw new Error(`Critical: Could not find ${key} file.`);
        };

        const [roster, retired, prefs, nobid, caps] = await Promise.all([
            fetchWithRetry('roster'), fetchWithRetry('retired'),
            fetchWithRetry('prefs'), fetchWithRetry('nobid'), fetchWithRetry('caps')
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

    // 1. Initialize Positions from Capacities JSON
    state.raw.caps.forEach(c => {
        const key = `${c.base} ${c.seat}`;
        state.positions[key] = {
            target: (c.startCapacity || 0) + (c.delta || 0),
            holding: [] 
        };
    });

    // 2. Build Active Pilot List (Excluding Retired and No-Bids)
    state.raw.roster.forEach(p => {
        if (noBidSens.has(p.sen) || retiredSens.has(p.sen)) return;

        const posKey = `${p.current.base} ${p.current.seat}`;
        const pPrefData = state.raw.prefs[`pil${p.sen}`] || state.raw.prefs[p.id];
        
        state.pilots.push({
            sen: p.sen,
            name: p.name,
            originalPos: posKey,
            awardedPos: posKey, // Default is currently holding
            displaced: false,
            preferences: (pPrefData?.preferences || [])
                .filter(pr => pr.bid && pr.bid.trim() !== "")
                .map(pr => ({
                    // Clean equipment tags to match "BASE SEAT" keys
                    bid: pr.bid.replace(/73G |737 /g, '').trim(),
                    bpl: pr.bpl_min || 0
                }))
        });
    });

    renderCapTable();
}

function renderCapTable() {
    const body = document.getElementById('cap-body');
    if (!body) return;
    body.innerHTML = '';
    Object.keys(state.positions).sort().forEach(key => {
        const pos = state.positions[key];
        body.innerHTML += `
            <tr>
                <td><strong>${formatPosName(key)}</strong></td>
                <td><input type="number" class="cap-input" value="${pos.target}" onchange="state.positions['${key}'].target = parseInt(this.value) || 0"></td>
            </tr>
        `;
    });
}

// --- CORE BID LOGIC ---

function runBid() {
    const pilots = state.pilots;
    const positions = state.positions;
    const logArea = document.getElementById('transaction-log');
    let transactionLogs = [];

    // 1. Initial State Setup & Displacements
    Object.keys(positions).forEach(k => {
        positions[k].holding = [];
        // Group pilots who currently sit in this base
        const currentInBase = pilots.filter(p => p.originalPos === k);
        // Sort junior to senior (highest number first) to displace from bottom
        currentInBase.sort((a,b) => b.sen - a.sen);
        
        const overage = currentInBase.length - positions[k].target;
        for (let i = 0; i < overage; i++) {
            if (currentInBase[i]) {
                currentInBase[i].awardedPos = null; // Unassign current spot
                currentInBase[i].displaced = true;
            }
        }

        // Add survivors to the holding list
        currentInBase.forEach(p => {
            if (p.awardedPos) {
                positions[k].holding.push(p);
                p.displaced = false;
            }
        });
    });

    transactionLogs.push(">> BID ENGINE STARTED: PROCESSING PREFERENCES BY SENIORITY");

    // 2. Main Award Loop (Honors Knock-on Effects)
    let awardFound = true;
    while (awardFound) {
        awardFound = false;
        // Process in strict seniority order (1 is most senior)
        pilots.sort((a, b) => a.sen - b.sen);

        for (let i = 0; i < pilots.length; i++) {
            const pilot = pilots[i];
            const currentAward = pilot.awardedPos;

            for (const pref of pilot.preferences) {
                // If they already have this or better, move to next pilot
                if (pref.bid === currentAward) break;

                const targetPos = positions[pref.bid];
                if (!targetPos) continue;

                // Rule 1: Vacancy Check
                const hasVacancy = targetPos.holding.length < targetPos.target;
                
                // Rule 2: BPL Check (BPL Rank = Seniors already there + 1)
                const currentBPLRank = targetPos.holding.filter(p => p.sen < pilot.sen).length + 1;
                const passesBPL = pref.bpl === 0 || currentBPLRank <= pref.bpl;

                if (hasVacancy && passesBPL) {
                    // --- LOG TRANSACTION ---
                    const targetOldVac = getVacancyCount(pref.bid);
                    let logStr = `Open position available. Reduce vacancy in ${formatPosName(pref.bid)} from ${targetOldVac} to ${targetOldVac - 1}.`;

                    // Handle backfill if leaving a spot
                    if (pilot.awardedPos) {
                        const oldPosKey = pilot.awardedPos;
                        const sourceOldVac = getVacancyCount(oldPosKey);
                        logStr += ` Increase vacancy in ${formatPosName(oldPosKey)} from ${sourceOldVac} to ${sourceOldVac + 1}.`;
                        
                        // Vacate old spot
                        positions[oldPosKey].holding = positions[oldPosKey].holding.filter(p => p.sen !== pilot.sen);
                    }

                    logStr += ` Proffered from ${pilot.sen} - ${pilot.name}.`;
                    transactionLogs.push(logStr);

                    // --- EXECUTE AWARD ---
                    pilot.awardedPos = pref.bid;
                    pilot.displaced = false;
                    targetPos.holding.push(pilot);
                    targetPos.holding.sort((a, b) => a.sen - b.sen);
                    
                    awardFound = true;
                    break; // Restart from Pilot #1
                }
            }
            if (awardFound) break; // Exit loop to restart while(awardFound)
        }
    }

    // 3. UI Update
    logArea.innerHTML = transactionLogs.join('<br><br>');
    renderResults();
}

function renderResults() {
    const tbody = document.getElementById('results-body');
    if (!tbody) return;
    tbody.innerHTML = '';
    
    state.pilots.sort((a,b) => a.sen - b.sen).forEach(p => {
        let status = p.awardedPos === p.originalPos ? 'held' : 'moved';
        let label = p.awardedPos === p.originalPos ? 'Held' : 'Awarded';
        
        if (p.displaced && !p.awardedPos) {
            status = 'displaced';
            label = 'UNASSIGNED (Displaced)';
        }

        const bplRank = p.awardedPos ? 
            state.positions[p.awardedPos].holding.filter(h => h.sen < p.sen).length + 1 : '-';

        tbody.innerHTML += `
            <tr>
                <td>${p.sen}</td>
                <td>${p.name}</td>
                <td>${formatPosName(p.originalPos)}</td>
                <td><strong>${formatPosName(p.awardedPos)}</strong></td>
                <td>${bplRank}</td>
                <td><span class="status ${status}">${label}</span></td>
            </tr>
        `;
    });
}
