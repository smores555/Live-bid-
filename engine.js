const FILE_MAP = {
    roster: ["roster (2).json", "roster.json"],
    retired: ["retired_pilots (2).json", "retired_pilots.json"],
    prefs: ["preferences (4).json", "preferences.json"],
    nobid: ["nobidpilots (2).json", "nobidpilots.json"],
    caps: ["capacities (4).json", "capacities.json"]
};

let state = { pilots: [], positions: {}, raw: {}, auditTrail: [] };

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
        status.innerText = "🟢 Data Synced";
        renderCapInputs();
    } catch (e) {
        status.innerText = "🔴 Load Error";
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

function runBidEngine() {
    state.auditTrail = [];
    const is737 = (seat) => seat && !seat.includes('320') && !seat.includes('321');
    const retiredSens = new Set(state.raw.retired.filter(p => is737(p.seat)).map(p => p.seniority));
    const noBidSens = new Set(state.raw.nobid.filter(p => is737(p.seat)).map(p => p.sen));

    let currentCounts = {};
    state.raw.caps.forEach(c => currentCounts[`${c.base}-${c.seat}`] = 0);

    const bidders = state.raw.roster
        .filter(p => is737(p.current.seat) && !retiredSens.has(p.sen) && !noBidSens.has(p.sen))
        .map(p => {
            const key = `${p.current.base}-${p.current.seat}`;
            currentCounts[key]++;
            const prefData = state.raw.prefs['pil' + p.sen] || state.raw.prefs[p.id] || { preferences: [] };
            return {
                ...p, currentKey: key, orig: key, moved: false, wasDisplaced: false, isSwept: false,
                prefHistory: {}, 
                prefs: (prefData.preferences || []).sort((a, b) => a.order - b.order)
            };
        }).sort((a, b) => a.sen - b.sen);

    let targetMap = {};
    state.raw.caps.forEach(c => {
        const delta = parseInt(document.getElementById(`delta-${c.base}-${c.seat}`).value) || 0;
        targetMap[`${c.base}-${c.seat}`] = currentCounts[`${c.base}-${c.seat}`] + delta;
    });

    let cascade = true;
    let loops = 0;

    while (cascade) {
        cascade = false;
        loops++;
        for (let p of bidders) {
            let foundAward = false;
            for (let pr of p.prefs) {
                if (!pr.bid) continue;
                const parts = pr.bid.trim().split(/\s+/);
                const targetKey = `${parts[1]}-${parts[2]}`;
                
                let rank = 1;
                for (let other of bidders) {
                    if (other.sen >= p.sen) break;
                    if (other.currentKey === targetKey) rank++;
                }

                const limit = targetMap[targetKey] || 0;
                const reqBPL = parseInt(pr.bpl_min) || 0;

                if (reqBPL > 0 && rank > reqBPL) {
                    p.prefHistory[pr.order] = { status: "Denied", reason: `BPL Fail (Rank ${rank} > Limit ${reqBPL})` };
                    continue; 
                }

                if (rank > limit) {
                    p.prefHistory[pr.order] = { status: "Denied", reason: `Displaced: Rank ${rank} exceeds capacity ${limit}.` };
                    if (targetKey === p.orig) p.wasDisplaced = true;
                    continue; 
                }

                if (targetKey === p.currentKey) {
                    p.prefHistory[pr.order] = { status: "Awarded", reason: `Remain in position. Rank: ${rank}.` };
                    foundAward = true; break;
                }

                if (currentCounts[targetKey] < limit) {
                    const oldKey = p.currentKey;
                    const oldVac = targetMap[oldKey] - currentCounts[oldKey];
                    const targetVac = targetMap[targetKey] - currentCounts[targetKey];

                    currentCounts[oldKey]--; 
                    currentCounts[targetKey]++;
                    
                    const log = `Open position available. Reduce vacancy in ${targetKey} from ${targetVac} to ${targetVac - 1}. Increase vacancy in ${oldKey} from ${oldVac} to ${oldVac + 1}. Proffered from ${p.sen} - ${p.name}.`;
                    state.auditTrail.push(log);
                    
                    p.prefHistory[pr.order] = { status: "Awarded", reason: log };
                    p.currentKey = targetKey; p.moved = true; cascade = true; foundAward = true; break; 
                }
            }

            if (!foundAward && p.wasDisplaced && !p.awardedPos) {
                for (let key in targetMap) {
                    if (currentCounts[key] < targetMap[key]) {
                        currentCounts[p.currentKey]--; currentCounts[key]++;
                        state.auditTrail.push(`FORCED SWEEP: ${p.sen} ${p.name} into ${key}`);
                        p.currentKey = key; p.isSwept = true; p.moved = true; cascade = true; foundAward = true; break;
                    }
                }
            }
            if (cascade) break; 
        }
        if (loops > 5000) break;
    }
    renderResults(bidders);
}

function renderResults(bidders) {
    document.getElementById('auditLog').innerHTML = state.auditTrail.join('\n');
    document.getElementById('tableBody').innerHTML = bidders.map(p => `
        <tr>
            <td>${p.sen}</td>
            <td><strong>${p.name}</strong> ${p.wasDisplaced ? '<span class="displaced-tag">DISPLACED</span>' : ''}
                <div class="pref-box">${Object.keys(p.prefHistory).map(o => `<div>${o}: <span class="status-${p.prefHistory[o].status}">${p.prefHistory[o].status}</span> - ${p.prefHistory[o].reason}</div>`).join('')}</div>
            </td>
            <td>${p.orig.replace('-',' ')}</td>
            <td style="color:${p.moved?'#3fb950':''}">${p.currentKey.replace('-',' ')}</td>
            <td>${p.moved ? 'AWARDED' : 'HELD'}</td>
        </tr>
    `).join('');
    
    document.getElementById('displacedList').innerHTML = bidders.filter(p => p.wasDisplaced).map(p => 
        `<div style="font-size:0.8rem; margin-bottom:5px;">#${p.sen} ${p.name}: ${p.orig} → ${p.currentKey} ${p.isSwept ? '(SWEEP)' : ''}</div>`
    ).join('') || "No displacements.";
}

document.getElementById('runBtn').onclick = runBidEngine;

// CSV EXPORTS
function downloadCSV(name, rows) {
    const csv = rows.map(r => r.map(c => `"${c}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name; a.click();
}

document.getElementById('expMaster').onclick = () => {
    const rows = [["Seniority", "Name", "Awarded Position", "Displaced", "Swept"]];
    state.pilots.forEach(p => rows.push([p.sen, p.name, p.currentKey, p.wasDisplaced, p.isSwept]));
    downloadCSV("Master_Awards.csv", rows);
};
