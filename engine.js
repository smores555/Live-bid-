<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>737 Bid Manager - Active Rank Master</title>
    <style>
        :root { --bg: #0b0e14; --card: #161b22; --text: #c9d1d9; --accent: #58a6ff; --border: #30363d; --green: #3fb950; --red: #f85149; }
        body { font-family: -apple-system, sans-serif; background: var(--bg); color: var(--text); padding: 20px; margin: 0; }
        .container { max-width: 1400px; margin: 0 auto; }
        
        .config-card { background: var(--card); padding: 15px; border-radius: 8px; border: 1px solid var(--border); margin-bottom: 20px; }
        .cap-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 10px; margin-top: 10px; }
        .cap-cell { display: flex; flex-direction: column; font-size: 0.65rem; }
        .cap-cell label { color: var(--accent); font-weight: bold; margin-bottom: 3px; }
        .cap-cell input { background: #0d1117; border: 1px solid var(--border); color: #4ade80; padding: 5px; border-radius: 4px; font-weight: bold; }

        .toolbar { display: flex; align-items: center; gap: 10px; background: var(--card); padding: 15px; border-radius: 8px; border: 1px solid var(--border); margin-bottom: 20px; }
        .btn { background: var(--accent); color: white; border: none; padding: 10px 15px; border-radius: 6px; font-weight: bold; cursor: pointer; }
        
        .mismatch-card { background: #2a1215; border: 1px solid var(--red); padding: 15px; border-radius: 8px; margin-bottom: 20px; }
        .audit-box { background: #0d1117; border: 1px solid var(--accent); border-radius: 8px; padding: 15px; font-family: monospace; font-size: 0.8rem; max-height: 250px; overflow-y: auto; margin-bottom: 20px; line-height: 1.5; }
        
        table { width: 100%; border-collapse: collapse; background: var(--card); border-radius: 8px; overflow: hidden; border: 1px solid var(--border); }
        th { background: #21262d; color: var(--accent); text-align: left; padding: 12px; font-size: 0.8rem; }
        td { padding: 12px; border-bottom: 1px solid var(--border); font-size: 0.85rem; vertical-align: top; }
        
        .pref-item { font-size: 0.75rem; margin-top: 6px; padding-top: 6px; border-top: 1px dashed #30363d; line-height: 1.4; color: #8b949e; }
        .status-Awarded { color: var(--green); font-weight: bold; }
        .status-Denied { color: var(--red); font-weight: bold; }
        .match { color: var(--green); }
        .mismatch { color: var(--red); font-weight: bold; }
        .hidden { display: none; }
    </style>
</head>
<body>

<div class="container">
    <div class="config-card">
        <h3 style="margin:0">Hard Target Deltas (737 Fleet)</h3>
        <div id="capGrid" class="cap-grid">Loading Data...</div>
    </div>

    <div id="validationBox" class="mismatch-card hidden">
        <h4 style="color:#ff7b72; margin:0 0 10px 0;">⚠️ Validation Mismatches (<span id="errCount">0</span>)</h4>
        <div id="mismatchList" style="display:grid; gap:8px;"></div>
    </div>

    <div class="toolbar">
        <button id="runBtn" class="btn">RUN 737 POSITION BID</button>
        <span id="loadInfo" style="font-size:0.85rem; color:var(--accent);">Ready.</span>
        <div style="flex-grow: 1;"></div>
        <input type="number" id="lookupInput" style="padding:10px; background:#0d1117; color:white; border:1px solid var(--border); border-radius:6px; width:120px;" placeholder="Sen #">
        <button id="lookupBtn" class="btn" style="background:#30363d;">PILOT LOOKUP</button>
    </div>

    <div id="auditLog" class="audit-box">Audit trail will appear here.</div>

    <table id="mainTable">
        <thead>
            <tr><th>Sen #</th><th>Pilot & Preference History</th><th>Original</th><th>Awarded</th><th>Status</th><th>Validation</th></tr>
        </thead>
        <tbody id="tableBody"></tbody>
    </table>
</div>

<script>
/**
 * THE 737 ACTIVE-ONLY ENGINE
 */
function runBidEngine(data, deltaMap) {
    const auditTrail = [];
    const is737 = (seat) => seat && !seat.includes('320') && !seat.includes('321');

    // Purge lists
    const retiredSens = new Set(data.retired.filter(p => is737(p.seat)).map(p => p.seniority));
    const noBid737 = data.noBid.filter(p => is737(p.seat));
    const noBidSens = new Set(noBid737.map(p => p.sen));

    // No-Bids occupy seats, but DO NOT count in Rank
    const noBidOccupancy = {};
    noBid737.forEach(p => noBidOccupancy[p.sen] = `${p.base}-${p.seat}`);

    let currentCounts = {};
    data.caps.forEach(c => currentCounts[`${c.base}-${c.seat}`] = 0);

    // Initial Seats for No-Bids
    for (let sen in noBidOccupancy) {
        const key = noBidOccupancy[sen];
        currentCounts[key] = (currentCounts[key] || 0) + 1;
    }

    // Filter roster for active 737 bidders
    const rosterMap = new Map();
    data.roster.forEach(p => {
        if (!rosterMap.has(p.sen) && is737(p.current.seat)) rosterMap.set(p.sen, p);
    });

    const bidders = Array.from(rosterMap.values())
        .filter(p => !retiredSens.has(p.sen) && !noBidSens.has(p.sen))
        .map(p => {
            const key = `${p.current.base}-${p.current.seat}`;
            currentCounts[key] = (currentCounts[key] || 0) + 1;
            const prefData = data.prefs['pil' + p.sen] || data.prefs[p.id] || { preferences: [] };
            return {
                ...p, currentKey: key, orig: key, moved: false,
                prefHistory: {}, 
                prefs: (prefData.preferences || []).sort((a, b) => a.order - b.order)
            };
        }).sort((a, b) => a.sen - b.sen);

    let targetMap = {};
    for (let key in currentCounts) {
        targetMap[key] = currentCounts[key] + (deltaMap[key] || 0);
    }

    let cascade = true;
    let loops = 0;

    while (cascade) {
        cascade = false;
        loops++;
        for (let i = 0; i < bidders.length; i++) {
            const p = bidders[i];
            for (const pr of p.prefs) {
                if (!pr.bid) continue;
                const parts = pr.bid.trim().split(/\s+/);
                if (parts.length < 3) continue;
                const targetKey = `${parts[1]}-${parts[2]}`;
                
                // --- RANK CALCULATION (ACTIVE BIDDERS ONLY) ---
                // We IGNORE No-Bids and Retired pilots here.
                let rank = 1;
                for (const other of bidders) {
                    if (other.sen >= p.sen) break;
                    if (other.currentKey === targetKey) rank++;
                }

                const reqBPL = parseInt(pr.bpl_min) || 0;
                const bplLog = reqBPL > 0 ? `. Requested BPL = ${reqBPL}. BPL if awarded = ${rank}.` : `. BPL if awarded = ${rank}.`;

                if (reqBPL > 0 && rank > reqBPL) {
                    p.prefHistory[pr.order] = { status: "Denied", reason: `BPL Fail${bplLog}` };
                    continue; 
                }

                if (targetKey === p.currentKey) {
                    p.prefHistory[pr.order] = { status: "Awarded", reason: `Remain in position${bplLog}` };
                    break;
                }

                const currentOcc = currentCounts[targetKey] || 0;
                const limit = targetMap[targetKey] || 0;
                const vBefore = limit - currentOcc;

                if (currentOcc < limit) {
                    const oldKey = p.currentKey;
                    const oldV = (targetMap[oldKey] || 0) - currentCounts[oldKey];

                    currentCounts[oldKey]--; 
                    currentCounts[targetKey]++;

                    const vAfter = limit - currentCounts[targetKey];

                    p.prefHistory[pr.order] = { 
                        status: "Awarded", 
                        reason: `Awarded! Vacancy ${vBefore}->${vAfter}. Vacated ${oldKey} ${oldV}->${oldV+1}${bplLog}` 
                    };

                    auditTrail.push({ loop: loops, sen: p.sen, name: p.name, from: oldKey, to: targetKey, vT: `${vBefore}->${vAfter}`, vF: `${oldV}->${oldV+1}` });
                    p.currentKey = targetKey;
                    p.moved = true;
                    cascade = true; // Restart from #1
                    break; 
                } else {
                    p.prefHistory[pr.order] = { status: "Denied", reason: `Full: ${vBefore} vacancies.` };
                }
            }
            if (cascade) break; 
        }
    }
    return { roster: bidders, loops, auditTrail };
}

/**
 * UI & DATA LOADING
 */
let store = {};
let answerKey = {};
let lastResults = [];

function parseCSV(text) {
    const rows = [];
    let currentRow = [];
    let field = '';
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        const next = text[i+1];
        if (inQuotes) {
            if (char === '"' && next === '"') { field += '"'; i++; }
            else if (char === '"') inQuotes = false;
            else field += char;
        } else {
            if (char === '"') inQuotes = true;
            else if (char === ',') { currentRow.push(field); field = ''; }
            else if (char === '\n' || char === '\r') {
                currentRow.push(field);
                if (currentRow.length > 1) rows.push(currentRow);
                currentRow = []; field = '';
                if (char === '\r' && next === '\n') i++;
            } else field += char;
        }
    }
    if (currentRow.length > 0 || field !== '') { currentRow.push(field); rows.push(currentRow); }
    return rows;
}

window.onload = async () => {
    try {
        const files = ['roster.json', 'preferences.json', 'capacities.json', 'retired_pilots.json', 'nobidpilots.json', 'answer_key.csv'];
        const results = await Promise.all(files.map(async f => {
            const r = await fetch(f);
            return f.endsWith('.csv') ? r.text() : r.json();
        }));
        store = { roster: results[0], prefs: results[1], caps: results[2], retired: results[3], noBid: results[4] };
        parseCSV(results[5]).forEach((cols, idx) => { if (idx > 0 && cols[0]) answerKey[cols[0].trim()] = cols[2]?.trim(); });
        renderCapacities();
    } catch (e) { console.error(e); }
};

function renderCapacities() {
    document.getElementById('capGrid').innerHTML = store.caps.map(c => `
        <div class="cap-cell"><label>${c.base} ${c.seat}</label><input type="number" id="delta-${c.base}-${c.seat}" value="${c.delta}"></div>
    `).join('');
}

document.getElementById('runBtn').onclick = () => {
    const deltas = {};
    store.caps.forEach(c => deltas[`${c.base}-${c.seat}`] = parseInt(document.getElementById(`delta-${c.base}-${c.seat}`).value) || 0);
    const result = runBidEngine(store, deltas);
    lastResults = result.roster;
    
    document.getElementById('auditLog').innerHTML = result.auditTrail.map(a => `
        <div style="border-bottom:1px solid #21262d; padding:4px 0;">[Pass ${a.loop}] <strong>#${a.sen} ${a.name}</strong> to ${a.to} (V: ${a.vT}) | Vacated ${a.from} (V: ${a.vF})</div>
    `).join('');

    renderTable(lastResults);
    renderMismatchAudit(lastResults);
};

function renderMismatchAudit(roster) {
    const list = document.getElementById('mismatchList');
    let count = 0;
    let html = '';
    roster.forEach(p => {
        const awarded = p.currentKey.replace('-', ' ');
        const company = (answerKey[p.sen.toString()] || "No Key").trim();
        const companyClean = company.replace(/^(737|73G|320|321)\s+/, '');
        if (!company.includes(awarded)) {
            count++;
            html += `<div style="background:#161b22; padding:8px; border-left:4px solid var(--red); font-size:0.8rem;">#${p.sen} ${p.name} | Engine: ${awarded} | Key: ${company}</div>`;
        }
    });
    document.getElementById('errCount').innerText = count;
    document.getElementById('validationBox').classList.toggle('hidden', count === 0);
    list.innerHTML = html;
}

document.getElementById('lookupBtn').onclick = () => {
    const sen = document.getElementById('lookupInput').value;
    if (sen && lastResults.length) renderTable(lastResults.filter(p => p.sen.toString() === sen));
};

function renderTable(roster) {
    document.getElementById('tableBody').innerHTML = roster.map(p => {
        const awarded = p.currentKey.replace('-', ' ');
        const company = answerKey[p.sen.toString()] || "No Key";
        const isMatch = company.includes(awarded);
        let prefHtml = '';
        for (let order in (p.prefHistory || {})) {
            const h = p.prefHistory[order];
            prefHtml += `<div class="pref-item"><strong>Pref ${order}:</strong> <span class="status-${h.status}">${h.status}</span> - ${h.reason}</div>`;
        }
        return `<tr><td>${p.sen}</td><td style="width:50%;"><strong>${p.name}</strong>${prefHtml}</td><td>${p.orig.replace('-',' ')}</td><td style="color:${p.moved?'#3fb950':''}">${awarded}</td><td>${p.moved?'AWARDED':'HELD'}</td><td class="${isMatch?'match':'mismatch'}">${isMatch?'✓ Match':'✗ '+company}</td></tr>`;
    }).join('');
}
</script>
</body>
</html>
