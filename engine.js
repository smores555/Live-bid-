/**

- AIRLINE BID ENGINE — LEDGER JOURNAL EDITION
- 
- Every pilot movement generates a numbered transaction (TXN) written to
- a running ledger journal. The journal is the auditable source of truth.
- Award Path strings are assembled from that journal after the cascade settles.
- 
- LEDGER FORMAT (per move):
- TXN #0012 | Loop 3 | Sen #140 — MATTHEWS, ROBERT C.
- STEP:    Preference Bid #1
- FROM:    Seattle Captain    [SEA-CA]   Vac 0 → 1  (Released)
- TO:      Portland Captain   [PDX-CA]   Vac 7 → 6  (Filled)
- SOURCE:  Open Vacancy — retirement / system reduction
- ──────────────────────────────────────────────────────
- 
- AWARD PATH column (same data, single-line):
- “Pref #1 — Portland Captain. Reduce PDX CA 7→6. Increase SEA CA 0→1.
- Source: Open Vacancy (retirement / system reduction).”
  */
  function runBidEngine(data, deltaMap) {

```
const is737 = (seat) => seat && !seat.includes('320') && !seat.includes('321');
const retiredSens = new Set(data.retired.filter(p => is737(p.seat)).map(p => p.seniority));
const noBidSens   = new Set(data.noBid.filter(p => is737(p.seat)).map(p => p.sen));
const activeBidders = data.roster.filter(p =>
    is737(p.current.seat) && !retiredSens.has(p.sen) && !noBidSens.has(p.sen)
);

// ── LABELS ───────────────────────────────────────────────────────────────
const BASE_NAMES = {
    ANC: 'Anchorage', SEA: 'Seattle',       LAX: 'Los Angeles',
    SAN: 'San Diego', SFO: 'San Francisco',  PDX: 'Portland',
    LAS: 'Las Vegas'
};
const SEAT_NAMES = { CA: 'Captain', FO: 'First Officer' };

const posLong  = (key) => { const [b,s] = (key||'').split('-'); return `${BASE_NAMES[b]||b} ${SEAT_NAMES[s]||s}`; };
const posShort = (key) => { const [b,s] = (key||'').split('-'); return `${b}-${s}`; };   // "SEA-CA"
const pad      = (str, n) => String(str).padEnd(n);

// ── SLOT SOURCE TRACKER ──────────────────────────────────────────────────
let slotSources = {};

const consumeSlot = (key) => {
    if (!slotSources[key]) slotSources[key] = [];
    return slotSources[key].length > 0
        ? slotSources[key].shift()
        : { type: 'vacancy', label: 'retirement / system reduction' };
};

const releaseSlot = (key, sen, name) => {
    if (!slotSources[key]) slotSources[key] = [];
    slotSources[key].push({ type: 'pilot', sen, name });
};

const fmtSource = (src) => {
    if (!src) return 'Unknown';
    if (src.type === 'pilot') return `Proffered — Sen #${src.sen} ${src.name}`;
    return `Open Vacancy — ${src.label}`;
};

// ── HEADCOUNT & TARGET MAP ───────────────────────────────────────────────
let liveHeadcount = {};
activeBidders.forEach(p => {
    const key = `${p.current.base}-${p.current.seat}`.toUpperCase();
    liveHeadcount[key] = (liveHeadcount[key] || 0) + 1;
});

let targetMap = {};
Object.keys(liveHeadcount).forEach(key => {
    targetMap[key] = liveHeadcount[key] + (deltaMap[key] || 0);
});
data.caps.forEach(c => {
    const key = `${c.base}-${c.seat}`.toUpperCase();
    if (targetMap[key] === undefined)
        targetMap[key] = c.startCapacity + (deltaMap[key] || 0);
});

// Seed pre-existing open slots
Object.keys(targetMap).forEach(key => {
    const open = (targetMap[key] || 0) - (liveHeadcount[key] || 0);
    slotSources[key] = [];
    for (let i = 0; i < open; i++)
        slotSources[key].push({ type: 'vacancy', label: 'retirement / system reduction' });
});

let currentCounts = { ...liveHeadcount };
const getVac = (key) => (targetMap[key] || 0) - (currentCounts[key] || 0);

// ── LEDGER JOURNAL ───────────────────────────────────────────────────────
// Each entry is a plain object — formatted for display separately.
const journal = [];
let txnCounter = 0;

function writeTxn({ loop, step, sen, name, fromKey, toKey, vacFromBefore, vacToBefore, source, prefOrder, bplRank, bplLimit, selfDisp }) {
    txnCounter++;
    const entry = {
        txn:          txnCounter,
        loop,
        step,           // 'A' | 'B' | 'C' | 'D'
        sen,
        name,
        fromKey,        // position pilot is leaving (null if staying)
        toKey,          // position pilot is going to
        vacFromBefore,  // vacancy in fromKey BEFORE this move
        vacFromAfter:   (vacFromBefore != null) ? vacFromBefore + 1 : null,
        vacToBefore,    // vacancy in toKey BEFORE this move
        vacToAfter:     (vacToBefore != null && toKey !== 'UNASSIGNED') ? vacToBefore - 1 : null,
        source,         // slot source object
        prefOrder,      // preference number (Step A only)
        bplRank,        // BPL rank (Step D self-disp only)
        bplLimit,
        selfDisp: !!selfDisp,
        stayed: (!fromKey && toKey !== 'UNASSIGNED')  // pilot didn't actually move
    };
    journal.push(entry);
    return entry;
}

// ── BUILD BIDDER LIST ────────────────────────────────────────────────────
const bidders = activeBidders.map(p => {
    const prefData  = data.prefs['pil' + p.sen] || data.prefs[p.id] || { preferences: [] };
    const pilotOrig = `${p.current.base}-${p.current.seat}`.toUpperCase();

    const getTargetKey = (bidStr) => {
        const parts = bidStr.trim().toUpperCase().split(/\s+/);
        const bases = ['ANC','SEA','LAX','SAN','SFO','PDX','LAS'];
        const seats = ['CA','FO'];
        const b = parts.find(x => bases.includes(x));
        const s = parts.find(x => seats.includes(x));
        return (b && s) ? `${b}-${s}` : null;
    };

    return {
        ...p,
        orig: pilotOrig,
        currentKey: pilotOrig,
        moved: false,
        isUnassigned: false,
        awardedPrefNum: "N/A",
        awardedReason: "Pending...",
        wasSelfDisplaced: false,
        txnRef: null,   // pointer to the pilot's final journal entry
        prefs: (prefData.preferences || []).map(pr => {
            let limit = parseInt(pr.bpl || pr.bpl_min);
            if (isNaN(limit) || limit === 0) limit = 9999;
            return { ...pr, targetKey: getTargetKey(pr.bid), bpl: limit };
        }).sort((a, b) => a.order - b.order)
    };
}).sort((a, b) => a.sen - b.sen);

// ── CASCADE ──────────────────────────────────────────────────────────────
let cascade = true;
let loops   = 0;

while (cascade) {
    cascade = false;
    loops++;

    for (let i = 0; i < bidders.length; i++) {
        const p = bidders[i];
        let awarded  = false;
        let newSeat  = null;
        let txn      = null;
        let prefNum  = "N/A";
        let selfDisp = false;
        const [origBase, origStatus] = p.orig.split('-');

        // ── A: Primary Preference Bids ────────────────────────────────────
        for (const pr of p.prefs) {
            if (!pr.targetKey) continue;
            const targetKey  = pr.targetKey;
            const cap        = targetMap[targetKey] || 0;
            const isMovingIn = p.currentKey !== targetKey;

            let rank = 1;
            for (const other of bidders) {
                if (other.sen >= p.sen) break;
                if (other.currentKey === targetKey) rank++;
            }

            const vacancyOk = isMovingIn ? getVac(targetKey) > 0 : true;

            if (rank <= pr.bpl && rank <= cap && vacancyOk) {
                newSeat = targetKey;
                prefNum = pr.order;
                awarded = true;

                if (isMovingIn) {
                    const src = consumeSlot(targetKey);
                    txn = writeTxn({
                        loop, step: 'A', sen: p.sen, name: p.name,
                        fromKey: p.currentKey, toKey: targetKey,
                        vacFromBefore: getVac(p.currentKey),
                        vacToBefore: getVac(targetKey),
                        source: src, prefOrder: pr.order
                    });
                } else {
                    // Stayed — write txn after cascade so vacancy is final
                    txn = { step: 'A', stayed: true, prefOrder: pr.order, toKey: targetKey, sen: p.sen, name: p.name };
                }
                break;
            }
        }

        // ── B: Seniority Hold ─────────────────────────────────────────────
        if (!awarded) {
            const cap = targetMap[p.orig] || 0;
            let rank  = 1;
            for (const other of bidders) {
                if (other.sen >= p.sen) break;
                if (other.currentKey === p.orig) rank++;
            }
            const selfBid  = p.prefs.find(pr => pr.targetKey === p.orig);
            const bplLimit = selfBid ? selfBid.bpl : 9999;

            if (rank <= bplLimit && rank <= cap) {
                newSeat = p.orig;
                awarded = true;
                txn = { step: 'B', stayed: true, toKey: p.orig, sen: p.sen, name: p.name };
            }
        }

        // ── C: Section 24 Displacement ────────────────────────────────────
        if (!awarded) {
            const opts = [
                ...['ANC','SEA','LAX','SAN','SFO','PDX','LAS']
                    .filter(b => b !== origBase).map(b => `${b}-${origStatus}`),
                `${origBase}-FO`,
                ...['ANC','SEA','LAX','SAN','SFO','PDX','LAS']
                    .filter(b => b !== origBase).map(b => `${b}-FO`)
            ];

            for (const targetKey of opts) {
                if (targetMap[targetKey] === undefined) continue;
                const cap        = targetMap[targetKey] || 0;
                const isMovingIn = p.currentKey !== targetKey;

                let rank = 1;
                for (const other of bidders) {
                    if (other.sen >= p.sen) break;
                    if (other.currentKey === targetKey) rank++;
                }

                const vacancyOk = isMovingIn ? getVac(targetKey) > 0 : true;

                if (rank <= cap && vacancyOk) {
                    newSeat = targetKey;
                    awarded = true;
                    const src = consumeSlot(targetKey);
                    txn = writeTxn({
                        loop, step: 'C', sen: p.sen, name: p.name,
                        fromKey: p.currentKey, toKey: targetKey,
                        vacFromBefore: getVac(p.currentKey),
                        vacToBefore: getVac(targetKey),
                        source: src
                    });
                    break;
                }
            }
        }

        // ── D: Pool / Unassigned ──────────────────────────────────────────
        if (!awarded) {
            newSeat = "UNASSIGNED";
            let rank = 1;
            for (const other of bidders) {
                if (other.sen >= p.sen) break;
                if (other.currentKey === p.orig) rank++;
            }
            const selfBid = p.prefs.find(pr => pr.targetKey === p.orig);
            selfDisp = selfBid && rank > selfBid.bpl;

            txn = writeTxn({
                loop, step: 'D', sen: p.sen, name: p.name,
                fromKey: p.currentKey, toKey: 'UNASSIGNED',
                vacFromBefore: getVac(p.currentKey),
                vacToBefore: null,
                source: null,
                selfDisp, bplRank: rank,
                bplLimit: selfBid ? selfBid.bpl : null,
                origKey: p.orig
            });
        }

        // ── STATE UPDATE ──────────────────────────────────────────────────
        p.awardedPrefNum   = prefNum;
        p.wasSelfDisplaced = selfDisp;
        p.txnRef           = txn;

        if (newSeat !== p.currentKey) {
            if (p.currentKey !== 'UNASSIGNED') {
                releaseSlot(p.currentKey, p.sen, p.name);
                currentCounts[p.currentKey]--;
            }
            if (newSeat !== 'UNASSIGNED') {
                currentCounts[newSeat] = (currentCounts[newSeat] || 0) + 1;
            }

            p.currentKey   = newSeat;
            p.moved        = newSeat !== p.orig;
            p.isUnassigned = newSeat === 'UNASSIGNED';

            cascade = true;
            break;
        } else {
            p.moved        = p.currentKey !== p.orig;
            p.isUnassigned = p.currentKey === 'UNASSIGNED';
        }
    }

    if (loops > 10000) break;
}

// ── FINAL PASS: write stayed/held journal entries + all awardedReason strings
// Stayed/held pilots write their TXN now so vacancy numbers are fully settled.
bidders.forEach(p => {
    const t = p.txnRef;
    if (!t) { p.awardedReason = "No bid data."; return; }

    const finalVac = (key) => (targetMap[key] || 0) - (currentCounts[key] || 0);

    if (t.stayed) {
        // Write the real journal entry now with settled numbers
        const vac = finalVac(t.toKey);
        const cap = targetMap[t.toKey] || 0;
        const fullEntry = writeTxn({
            loop: loops, step: t.step, sen: t.sen, name: t.name,
            fromKey: null, toKey: t.toKey,
            vacFromBefore: null, vacToBefore: vac,
            source: null, prefOrder: t.prefOrder || null
        });
        p.txnRef = fullEntry;

        const stepLabel = t.step === 'A'
            ? `Awarded Pref #${t.prefOrder} — Remained in ${posLong(t.toKey)}`
            : `Held Position (Seniority) — ${posLong(t.toKey)}`;

        p.awardedReason = `${stepLabel}. ${posShort(t.toKey)} vacancy: ${vac} open of ${cap}.`;

    } else if (t.step === 'A') {
        p.awardedReason = [
            `Awarded Pref #${t.prefOrder} — ${posLong(t.toKey)}.`,
            `Source: ${fmtSource(t.source)}.`,
            `Reduce vacancy in ${posShort(t.toKey)} from ${t.vacToBefore} to ${t.vacToAfter}.`,
            `Increase vacancy in ${posShort(t.fromKey)} from ${t.vacFromBefore} to ${t.vacFromAfter}.`
        ].join(' ');

    } else if (t.step === 'C') {
        p.awardedReason = [
            `Section 24 — ${posLong(t.toKey)}.`,
            `Source: ${fmtSource(t.source)}.`,
            `Reduce vacancy in ${posShort(t.toKey)} from ${t.vacToBefore} to ${t.vacToAfter}.`,
            `Increase vacancy in ${posShort(t.fromKey)} from ${t.vacFromBefore} to ${t.vacFromAfter}.`
        ].join(' ');

    } else if (t.step === 'D') {
        p.awardedReason = t.selfDisp
            ? `BPL Failure — Rank ${t.bplRank} > Limit ${t.bplLimit} for ${posLong(t.origKey)}. Increase vacancy in ${posShort(t.fromKey)} from ${t.vacFromBefore} to ${t.vacFromAfter}.`
            : `Displaced — no position available. Increase vacancy in ${posShort(t.fromKey)} from ${t.vacFromBefore} to ${t.vacFromAfter}.`;
    }
});

// ── FORMAT LEDGER FOR DISPLAY ────────────────────────────────────────────
// journal[] contains raw objects. ledgerText is a human-readable block
// suitable for a <pre> or monospace display panel.
const DIV = '\u2500'.repeat(62);

const ledgerText = journal.map(e => {
    const stepNames = { A: 'Preference Bid', B: 'Seniority Hold', C: 'Section 24', D: 'Displaced / Pool' };
    const lines = [
        `TXN #${String(e.txn).padStart(4,'0')}  |  Loop ${e.loop}  |  Sen #${e.sen} \u2014 ${e.name}`,
        `STEP:    ${stepNames[e.step] || e.step}${e.prefOrder ? ' #' + e.prefOrder : ''}${e.stayed ? ' (No Move)' : ''}`
    ];

    if (e.fromKey) {
        lines.push(`FROM:    ${pad(posLong(e.fromKey), 22)} [${e.fromKey}]   Vac ${e.vacFromBefore} \u2192 ${e.vacFromAfter}  (Released)`);
    }
    if (e.toKey && e.toKey !== 'UNASSIGNED') {
        const action = e.stayed ? 'Held' : 'Filled';
        lines.push(`TO:      ${pad(posLong(e.toKey), 22)} [${e.toKey}]   Vac ${e.vacToBefore} \u2192 ${e.vacToAfter ?? e.vacToBefore}  (${action})`);
    }
    if (e.toKey === 'UNASSIGNED') {
        lines.push(`TO:      UNASSIGNED / POOL`);
    }
    if (e.source) {
        lines.push(`SOURCE:  ${fmtSource(e.source)}`);
    }
    if (e.selfDisp) {
        lines.push(`BPL:     Rank ${e.bplRank} exceeded limit of ${e.bplLimit}`);
    }
    lines.push(DIV);
    return lines.join('\n');
}).join('\n');

return { roster: bidders, loops, journal, ledgerText, targetMap };
```

}
