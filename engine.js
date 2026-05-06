const FILE_MAP = {
    roster: ["roster (2).json", "roster.json"],
    retired: ["retired_pilots (2).json", "retired_pilots.json"],
    prefs: ["preferences (4).json", "preferences.json"],
    nobid: ["nobidpilots (2).json", "nobidpilots.json"],
    caps: ["capacities (4).json", "capacities.json"]
};

let state = { pilots: [], positions: {}, raw: {}, logs: [] };

// 1. DATA LOADING
window.onload = async () => {
    const status = document.getElementById('load-status');
    try {
        const fetchFile = async (key) => {
            for (let name of FILE_MAP[key]) {
                const r = await fetch(`./${encodeURIComponent(name)}`);
                if (r.ok) return await r.json();
            }
            throw new Error(`Missing ${key}`);
        };

        const [roster, retired, prefs, nobid, caps] = await Promise.all([
            fetchFile('roster'), fetchFile('retired'), fetchFile('prefs'), 
            fetchFile('nobid'), fetchFile('caps')
        ]);

        state.raw = { roster, retired, prefs, nobid, caps };
        status.innerText = "🟢 DATA READY";
        renderCapInputs();
    } catch (e) {
        status.innerText = "🔴 LOAD ERROR";
    }
};

function renderCapInputs() {
    document.getElementById('capGrid').innerHTML = state.raw.caps.map(c => `
        <div class="cap-cell">
            <label>${c.base} ${c.seat}</label>
            <input type="number" id="delta-${c.base}-${c.seat}" value="${c.delta || 0}">
        </div>
    `).join('');
}

// 2. THE BID ENGINE
function runBid() {
    state.logs = [];
    const is737 = (seat) => seat && !seat.includes('320') && !seat.includes('321');
    const retiredSens = new Set(state.raw.retired.filter(p => is737(p.seat)).map(p => p.seniority));
    const noBidSens = new Set(state.raw.nobid.filter(p => is737(p.seat)).map(p => p.sen));

    let currentCounts = {};
    state.raw.caps.forEach(c => currentCounts[`${c.base}-${c.seat}`] = 0);

    // Initial Filter & Capacity Setup
    const bidders = state.raw.roster
        .filter(p => is737(p.current.seat) && !retiredSens.has(p.sen) && !noBidSens.has(p.sen))
        .map(p => {
            const key = `${p.current.base}-${p.current.seat}`;
            currentCounts[key]++;
            const pPref = state.raw.prefs['pil' + p.sen] || state.raw.prefs[p.id] || { preferences: [] };
            return {
                ...p, currentKey: key, orig: key, moved: false, displaced: false, prefHistory: {},
                prefs: (pPref.preferences || []).filter(pr => pr.bid).sort((a,b) => a.order - b.order)
            };
        }).sort((a, b) => a.sen - b.sen);

    let targetMap = {};
    state.raw.caps.forEach(c => {
        const d = parseInt(document.getElementById(`delta-${c.base}-${c.seat}`).value) || 0;
        targetMap[`${c.base}-${c.seat}`] = currentCounts[`${c.base}-${c.seat}`] + d;
    });

    // Step A: Handle Initial Displacements (Bottom-Up)
    Object.keys(targetMap).forEach(key => {
        const inBase = bidders.filter(p => p.orig === key).sort((a,b) => b.sen - a.sen);
        const overage = inBase.length - targetMap[key];
        for(let i=0; i<overage; i++) {
            inBase[i].currentKey = null; inBase[i].displaced = true;
            currentCounts[key]--;
        }
    });

    // Step B: Seniority Cascade (Restart-on-Award)
    let changed = true;
    while (changed) {
        changed = false;
        for (let p of bidders) {
            let found = false;
            for (let pr of p.prefs) {
                const targetKey = pr.bid.replace(/73G |737 /g, '').trim().split(/\s+/).slice(1).join('-');
                if (targetKey === p.currentKey) { 
                    p.prefHistory[pr.order] = { status: "Current", reason: "Holds current position." };
                    found = true; break; 
                }

                let rank = bidders.filter(o => o.sen < p.sen && o.currentKey === targetKey).length + 1;
                const limit = targetMap[targetKey] || 0;
                const reqBPL = parseInt(pr.bpl_min) || 0;

                if (reqBPL > 0 && rank > reqBPL) {
                    p.prefHistory[pr.order] = { status: "Denied", reason: `BPL Fail: Rank ${rank} > Limit ${reqBPL}` };
                    continue;
                }

                if (currentCounts[targetKey] < limit) {
                    const oldKey = p.currentKey;
                    const oldVac = oldKey ? (targetMap[oldKey] - currentCounts[oldKey]) : "-";
                    const targetVac = limit - currentCounts[targetKey];

                    if (oldKey) currentCounts[oldKey]--;
                    currentCounts[targetKey]++;

                    const logMsg = `Open position available. Reduce vacancy in ${targetKey} from ${targetVac} to ${targetVac - 1}.${oldKey ? ` Increase vacancy in ${oldKey} from ${oldVac} to ${oldVac + 1}.` : ''} Proffered from ${p.sen} - ${p.name}.`;
                    state.logs.push(logMsg);
                    p.prefHistory[pr.order] = { status: "Awarded", reason: logMsg };
                    p.currentKey = targetKey; p.moved = true; changed = true; found = true; break;
                } else {
                    p.prefHistory[pr.order] = { status: "Denied", reason: `Full: 0 vacancies.` };
                }
            }
            if (changed) break; 
        }
    }
    renderUI(bidders, targetMap, currentCounts);
}

function renderUI(bidders, targetMap, currentCounts) {
    document.getElementById('auditLog').innerText = state.logs.join('\n\n');
    document.getElementById('tableBody').innerHTML = bidders.map(p => `
        <tr>
            <td>${p.sen}</td>
            <td><strong>${p.name}</strong> ${p.displaced ? '<span class="displaced-tag">DISPLACED</span>' : ''}
                <div class="pref-box">${Object.keys(p.prefHistory).map(o => `<div>${o}: <span class="status-${p.prefHistory[o].status}">${p.prefHistory[o].status}</span> - ${p.prefHistory[o].reason}</div>`).join('')}</div>
            </td>
            <td>${p.orig.replace('-',' ')}</td>
            <td style="color:${p.moved?'#3fb950':''}">${(p.currentKey || '---').replace('-',' ')}</td>
            <td>${p.moved ? 'AWARDED' : 'HELD'}</td>
        </tr>
    `).join('');

    document.getElementById('displacedList').innerHTML = bidders.filter(p => p.displaced).map(p => `<div>#${p.sen} ${p.name}: ${p.orig} → ${p.currentKey || 'UNASSIGNED'}</div>`).join('') || "None";
    document.getElementById('vacancySummary').innerHTML = Object.keys(targetMap).map(k => `<div>${k}: ${targetMap[k] - currentCounts[k]} Open</div>`).join('');
}

// CSV Export Logic
function exportTrans() {
    const csv = "data:text/csv;charset=utf-8,Transaction\n" + state.logs.map(l => `"${l}"`).join("\n");
    window.open(encodeURI(csv));
}
