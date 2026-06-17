/**
 * AIRLINE BID ENGINE - COMPANY-MATCHING EDITION
 * 
 * Key fixes:
 * 1. Uses ACTUAL starting vacancy counts from company data (not computed)
 * 2. Tracks vacancy changes in REAL-TIME as bids are awarded
 * 3. Outputs 73G equipment prefix to match company format
 * 4. Shows BPL calculations inline in Award Notes
 * 5. Records who was actually displaced (proffered from seniority#)
 */

function runBidEngine(data, deltaMap, startingVacancies) {
    const auditTrail = [];
    const bidTransactions = [];  // ← NEW: Log every bid attempt
    const is737 = (p) => p.current && p.current.equip === "737";

    // ── FIXED PILOT EXCLUSION LOGIC ──────────────────────────────────────────
    const retiredSens = new Set(data.retired.map(p => p.sen || p.seniority));
    const noBidSens   = new Set(data.noBid.map(p => p.sen || p.seniority));

    const activeBidders = data.roster.filter(p =>
        is737(p) && !retiredSens.has(p.sen) && !noBidSens.has(p.sen)
    );

    // ── LABEL HELPERS ────────────────────────────────────────────────────────
    const baseNames = {
        ANC: 'Anchorage', SEA: 'Seattle',      LAX: 'Los Angeles',
        SAN: 'San Diego', SFO: 'San Francisco', PDX: 'Portland'
    };
    const seatNames = { CA: 'Captain', FO: 'First Officer' };

    function keyLabel(key) {
        const [base, seat] = (key || '').split('-');
        return `73G ${base} ${seat}`;  // ADD 73G PREFIX
    }

    function posLabel(key) {
        const [base, seat] = (key || '').split('-');
        return `${baseNames[base] || base} ${seatNames[seat] || seat}`;
    }

    // ── VACANCY TRACKING: Use ACTUAL starting numbers from company ────────────
    // startingVacancies is a map like { 'ANC-CA': 2, 'SEA-FO': 1, ... }
    let vacancies = { ...startingVacancies };  // COPY to avoid mutation
    
    function getVac(key) {
        return vacancies[key] || 0;
    }

    function setVac(key, newCount) {
        vacancies[key] = newCount;
    }

    // ── SLOT SOURCES: Track who vacated each position ────────────────────────
    let slotSources = {};

    function consumeSlot(key) {
        if (!slotSources[key]) slotSources[key] = [];
        return slotSources[key].length > 0
            ? slotSources[key].shift()
            : { type: 'vacancy', label: 'retirement / system reduction' };
    }

    function releaseSlot(key, pilotSen, pilotName) {
        if (!slotSources[key]) slotSources[key] = [];
        slotSources[key].push({ type: 'pilot', sen: pilotSen, name: pilotName });
    }

    function fmtSource(src) {
        if (!src) return 'Source unknown.';
        if (src.type === 'pilot') return `Proffered from ${src.sen} - ${src.name}.`;
        return `Open position available (${src.label}).`;
    }

    // ── HEADCOUNT & TARGET MAP ───────────────────────────────────────────────
    let currentCounts = {};
    activeBidders.forEach(p => {
        const key = `${p.current.base}-${p.current.seat}`.toUpperCase();
        currentCounts[key] = (currentCounts[key] || 0) + 1;
    });

    let targetMap = {};
    Object.keys(currentCounts).forEach(key => {
        targetMap[key] = currentCounts[key] + (deltaMap[key] || 0);
    });
    
    if (data.caps) {
        data.caps.forEach(c => {
            const key = `${c.base}-${c.seat}`.toUpperCase();
            if (targetMap[key] === undefined) {
                targetMap[key] = c.startCapacity + (deltaMap[key] || 0);
            }
        });
    }

    // Initialize slot sources for pre-existing vacancies
    Object.keys(vacancies).forEach(key => {
        const vac = vacancies[key];
        if (vac > 0) {
            if (!slotSources[key]) slotSources[key] = [];
            for (let i = 0; i < vac; i++) {
                slotSources[key].push({ type: 'vacancy', label: 'retirement / system reduction' });
            }
        }
    });

    // ── BUILD BIDDER LIST ────────────────────────────────────────────────────
    const bidders = activeBidders.map(p => {
        const prefData  = data.prefs['pil' + p.sen] || data.prefs[p.id] || { preferences: [] };
        const pilotOrig = `${p.current.base}-${p.current.seat}`.toUpperCase();

        const getTargetKey = (bidStr) => {
            const parts = bidStr.trim().toUpperCase().split(/\s+/);
            const bases = ['ANC', 'SEA', 'LAX', 'SAN', 'SFO', 'PDX'];
            const seats = ['CA', 'FO'];
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
            isForceDisplaced: false,
            moveLog: null,
            failedPrefs: [],
            reductionEvents: [],
            reHoldEvents: [],
            holdEvents: [],
            prefs: (prefData.preferences || []).map(pr => {
                let limit = parseInt(pr.bpl || pr.bpl_min);
                if (isNaN(limit) || limit === 0) limit = 9999;
                return { ...pr, targetKey: getTargetKey(pr.bid), bpl: limit };
            }).sort((a, b) => a.order - b.order)
        };
    }).sort((a, b) => a.sen - b.sen);

    // ── HELPER: is pilot force-displaced from their current base? ────────────
    function isForceDisplacedFrom(pilot, key) {
        const cap = targetMap[key] || 0;
        let rank = 1;
        for (const other of bidders) {
            if (other.sen >= pilot.sen) break;
            if (other.currentKey === key) rank++;
        }
        return rank > cap;
    }

    // ── HELPER: find the most junior pilot currently at a key ────────────────
    function mostJuniorAt(key, excludeSen) {
        let junior = null;
        for (const other of bidders) {
            if (other.currentKey === key && other.sen !== excludeSen) {
                if (!junior || other.sen > junior.sen) {
                    junior = other;
                }
            }
        }
        return junior;
    }

    // ── MAIN CASCADE LOOP ────────────────────────────────────────────────────
    let cascade = true;
    let loops   = 0;

    while (cascade) {
        cascade = false;
        loops++;
        const bumpedThisLoop = new Set();

        for (let i = 0; i < bidders.length; i++) {
            const p = bidders[i];
            let awarded      = false;
            let newSeat      = null;
            let log          = null;
            let prefNum      = "N/A";
            let selfDisp     = false;
            let failedPrefs  = [];
            const [origBase, origStatus] = p.orig.split('-');

            const forcedOut = isForceDisplacedFrom(p, p.orig);

            // Record reduction events when pilot is forced out
            if (forcedOut) {
                const cap = targetMap[p.orig] || 0;
                let boundaryPilot = null;
                let count = 0;
                for (const other of bidders) {
                    if (other.sen >= p.sen) break;
                    if (other.currentKey === p.orig) {
                        count++;
                        if (count === cap) { boundaryPilot = other; break; }
                    }
                }
                if (!boundaryPilot) {
                    for (const other of bidders) {
                        if (other.sen >= p.sen) break;
                        if (other.currentKey === p.orig) boundaryPilot = other;
                    }
                }
                const minSen = boundaryPilot ? boundaryPilot.sen : p.sen;
                const alreadyRecorded = p.reductionEvents.some(e => e.fromKey === p.orig);
                if (!alreadyRecorded) p.reductionEvents.push({ fromKey: p.orig, minSen, loop: loops });
            }

            // ── STEP A: Work through submitted preferences ──────────────────
            for (const pr of p.prefs) {
                if (!pr.targetKey) continue;
                const targetKey  = pr.targetKey;
                const cap        = targetMap[targetKey] || 0;
                const isMovingIn = (p.currentKey !== targetKey);

                let rank = 1;
                for (const other of bidders) {
                    if (other.sen >= p.sen) break;
                    if (other.currentKey === targetKey) rank++;
                }

                let vacancyOk;
                if (forcedOut && isMovingIn) {
                    const junior = mostJuniorAt(targetKey, p.sen);
                    vacancyOk = getVac(targetKey) > 0 || (junior !== null && p.sen < junior.sen);
                } else {
                    vacancyOk = isMovingIn ? getVac(targetKey) > 0 : true;
                }

                if (rank > pr.bpl) {
                    failedPrefs.push({ order: pr.order, targetKey, fromKey: p.currentKey, reason: `Bid request does not meet BPL requirement. Requested BPL = ${pr.bpl}. BPL if awarded = ${rank}.`, status: 'Denied', denialType: 'bpl', loop: loops });
                    // ← NEW: Log this denied bid
                    bidTransactions.push({
                        sen: p.sen, name: p.name, startingPosition: p.orig, bidPosition: targetKey,
                        awardStatus: 'Denied',
                        awardNote: `Bid request does not meet BPL requirement. Requested BPL = ${pr.bpl}. BPL if awarded = ${rank}.`
                    });
                } else if (rank > cap) {
                    const vac = getVac(targetKey);
                    const msg = vac <= 0
                        ? `Requested position has ${vac} vacancy and cannot accept additional pilots.`
                        : `Seniority is not high enough to hold position. Minimum position seniority is ${cap}.`;
                    failedPrefs.push({ order: pr.order, targetKey, fromKey: p.currentKey, reason: msg, status: 'Denied', loop: loops });
                    // ← NEW: Log this denied bid
                    bidTransactions.push({
                        sen: p.sen, name: p.name, startingPosition: p.orig, bidPosition: targetKey,
                        awardStatus: 'Denied', awardNote: msg
                    });
                } else if (isMovingIn && !vacancyOk) {
                    failedPrefs.push({ order: pr.order, targetKey, fromKey: p.currentKey, reason: `Requested position has ${getVac(targetKey)} vacancy and cannot accept additional pilots.`, status: 'Denied', loop: loops });
                    // ← NEW: Log this denied bid
                    bidTransactions.push({
                        sen: p.sen, name: p.name, startingPosition: p.orig, bidPosition: targetKey,
                        awardStatus: 'Denied',
                        awardNote: `Requested position has ${getVac(targetKey)} vacancy and cannot accept additional pilots.`
                    });
                }

                if (rank <= pr.bpl && rank <= cap && vacancyOk) {
                    newSeat = targetKey;
                    prefNum = pr.order;
                    awarded = true;

                    if (isMovingIn) {
                        const vacBefore = getVac(targetKey);
                        const hasVac = vacBefore > 0;
                        let bumpedPilot = null;

                        if (forcedOut && !hasVac) {
                            bumpedPilot = mostJuniorAt(targetKey, p.sen);
                            if (bumpedPilot && bumpedThisLoop.has(bumpedPilot.sen)) bumpedPilot = null;
                            if (bumpedPilot) {
                                bumpedPilot.isForceDisplaced = true;
                                bumpedThisLoop.add(bumpedPilot.sen);
                            }
                            log = {
                                step: 'A',
                                prefOrder: pr.order,
                                fromKey: p.currentKey,
                                toKey: targetKey,
                                vacFromBefore: getVac(p.currentKey),
                                vacToBefore: vacBefore,
                                source: bumpedPilot
                                    ? { type: 'pilot', sen: bumpedPilot.sen, name: bumpedPilot.name }
                                    : { type: 'vacancy', label: 'retirement / system reduction' },
                                displacementBump: !!bumpedPilot,
                                bumpedSen: bumpedPilot ? bumpedPilot.sen : null,
                                forcedOut
                            };
                        } else {
                            const src = consumeSlot(targetKey);
                            log = {
                                step: 'A',
                                prefOrder: pr.order,
                                fromKey: p.currentKey,
                                toKey: targetKey,
                                vacFromBefore: getVac(p.currentKey),
                                vacToBefore: vacBefore,
                                source: src,
                                displacementBump: false,
                                forcedOut
                            };
                        }
                    } else {
                        if (p.orig === targetKey) {
                            log = { step: 'A', prefOrder: pr.order, fromKey: null, toKey: targetKey, stayed: true, forcedOut };
                        } else {
                            log = p.moveLog;
                        }
                    }
                    // ← NEW: Log this awarded preference
                    bidTransactions.push({
                        sen: p.sen, name: p.name, startingPosition: p.orig, bidPosition: targetKey,
                        awardStatus: 'Awarded', awardNote: buildReasonFromLog(log)
                    });
                    break;
                }
            }

            // ── STEP B: No pref awarded — try holding at orig base ──────────
            if (!awarded) {
                const cap      = targetMap[p.orig] || 0;
                const vacAtOrig = getVac(p.orig);
                let rank = 1;
                for (const other of bidders) {
                    if (other.sen >= p.sen) break;
                    if (other.currentKey === p.orig) rank++;
                }
                const selfBid  = p.prefs.find(pr => pr.targetKey === p.orig);
                const bplLimit = selfBid ? selfBid.bpl : 9999;

                const canHold = (rank <= bplLimit && rank <= cap) ||
                                (forcedOut && vacAtOrig > 0 && rank <= bplLimit);

                if (canHold) {
                    newSeat = p.orig;
                    awarded = true;
                    log = { step: 'B', fromKey: null, toKey: p.orig, stayed: true, forcedOut };
                    // ← NEW: Log Step B award
                    bidTransactions.push({
                        sen: p.sen, name: p.name, startingPosition: p.orig, bidPosition: p.orig,
                        awardStatus: 'Awarded', awardNote: 'Remain in current position.'
                    });
                }
            }

            // ── STEP C: Force / Section-24 displacement fallback ────────────
            if (!awarded) {
                const cascadeOptions = [
                    `${origBase}-${origStatus}`,
                    ...['ANC', 'SEA', 'LAX', 'SAN', 'SFO', 'PDX']
                        .filter(b => b !== origBase).map(b => `${b}-${origStatus}`),
                    `${origBase}-FO`,
                    ...['ANC', 'SEA', 'LAX', 'SAN', 'SFO', 'PDX']
                        .filter(b => b !== origBase).map(b => `${b}-FO`)
                ];

                for (const targetKey of cascadeOptions) {
                    if (targetMap[targetKey] === undefined) continue;
                    const cap        = targetMap[targetKey] || 0;
                    const isMovingIn = (p.currentKey !== targetKey);

                    let rank = 1;
                    for (const other of bidders) {
                        if (other.sen >= p.sen) break;
                        if (other.currentKey === targetKey) rank++;
                    }

                    let vacancyOk;
                    if (forcedOut && isMovingIn) {
                        const junior = mostJuniorAt(targetKey, p.sen);
                        vacancyOk = getVac(targetKey) > 0 || (junior !== null && p.sen < junior.sen);
                    } else {
                        vacancyOk = isMovingIn ? getVac(targetKey) > 0 : true;
                    }

                    if (rank <= cap && vacancyOk) {
                        newSeat = targetKey;
                        awarded = true;

                        if (isMovingIn) {
                            const vacBefore = getVac(targetKey);
                            const hasVac = vacBefore > 0;
                            let bumpedPilot = null;

                            if (forcedOut && !hasVac) {
                                bumpedPilot = mostJuniorAt(targetKey, p.sen);
                                if (bumpedPilot && bumpedThisLoop.has(bumpedPilot.sen)) bumpedPilot = null;
                                if (bumpedPilot) {
                                    bumpedPilot.isForceDisplaced = true;
                                    bumpedThisLoop.add(bumpedPilot.sen);
                                }
                                log = {
                                    step: 'C',
                                    fromKey: p.currentKey,
                                    toKey: targetKey,
                                    vacFromBefore: getVac(p.currentKey),
                                    vacToBefore: vacBefore,
                                    source: bumpedPilot
                                        ? { type: 'pilot', sen: bumpedPilot.sen, name: bumpedPilot.name }
                                        : { type: 'vacancy', label: 'retirement / system reduction' },
                                    displacementBump: !!bumpedPilot,
                                    bumpedSen: bumpedPilot ? bumpedPilot.sen : null,
                                    forcedOut
                                };
                            } else {
                                const src = consumeSlot(targetKey);
                                log = {
                                    step: 'C',
                                    fromKey: p.currentKey,
                                    toKey: targetKey,
                                    vacFromBefore: getVac(p.currentKey),
                                    vacToBefore: vacBefore,
                                    source: src,
                                    displacementBump: false,
                                    forcedOut
                                };
                            }
                        } else {
                            log = p.moveLog;
                        }
                        // ← NEW: Log Step C award
                        bidTransactions.push({
                            sen: p.sen, name: p.name, startingPosition: p.orig, bidPosition: targetKey,
                            awardStatus: 'Awarded', awardNote: buildReasonFromLog(log)
                        });
                        break;
                    }
                }
            }

            // ── STEP D: Truly unassigned ─────────────────────────────────────
            if (!awarded) {
                newSeat = "UNASSIGNED";
                let rank = 1;
                for (const other of bidders) {
                    if (other.sen >= p.sen) break;
                    if (other.currentKey === p.orig) rank++;
                }
                const selfBid = p.prefs.find(pr => pr.targetKey === p.orig);
                selfDisp = selfBid && rank > selfBid.bpl;
                log = {
                    step: 'D',
                    fromKey: p.currentKey,
                    toKey: 'UNASSIGNED',
                    vacFromBefore: getVac(p.currentKey),
                    selfDisp,
                    forcedOut,
                    bplRank: rank,
                    bplLimit: selfBid ? selfBid.bpl : null,
                    origKey: p.orig
                };
            }

            p.awardedPrefNum   = prefNum;
            p.wasSelfDisplaced = selfDisp;
            p.moveLog          = log;
            p.failedPrefs = failedPrefs;

            if (newSeat !== p.currentKey) {
                const prevKey = p.currentKey;

                // UPDATE VACANCIES IN REAL-TIME
                if (p.currentKey !== "UNASSIGNED") {
                    releaseSlot(p.currentKey, p.sen, p.name);
                    currentCounts[p.currentKey]--;
                    setVac(p.currentKey, getVac(p.currentKey) + 1);  // Release increases vacancy
                }
                if (newSeat !== "UNASSIGNED") {
                    currentCounts[newSeat] = (currentCounts[newSeat] || 0) + 1;
                    setVac(newSeat, getVac(newSeat) - 1);  // Consume decreases vacancy
                }

                p.currentKey   = newSeat;
                p.moved        = (newSeat !== p.orig);
                p.isUnassigned = (newSeat === "UNASSIGNED");

                auditTrail.push({ loop: loops, sen: p.sen, name: p.name, from: prevKey, to: newSeat, log });

                cascade = true;
                break;
            } else {
                p.moved        = (p.currentKey !== p.orig);
                p.isUnassigned = (p.currentKey === "UNASSIGNED");

                if (forcedOut && awarded) {
                    p.reHoldEvents.push({ loop: loops, key: p.currentKey, log });
                }
            }
        }
        if (loops > 10000) break;
    }

    // ── BUILD REASON STRING FROM A LOG OBJECT ────────────────────────────────
    function buildReasonFromLog(log) {
        if (!log) return "No bid data.";
        
        const bumpNote = (log.displacementBump && log.bumpedSen)
            ? ` Bumped Sen #${log.bumpedSen} (displacement chain).`
            : '';

        if (log.step === 'A' && !log.stayed) {
            const line1 = `Awarded Pref #${log.prefOrder} — ${posLabel(log.toKey)}. ${fmtSource(log.source)}${bumpNote}`;
            const line2 = log.displacementBump
                ? `Displacement move — no vacancy consumed in ${keyLabel(log.toKey)}. Increase vacancy in ${keyLabel(log.fromKey)} from ${log.vacFromBefore} to ${log.vacFromBefore + 1}.`
                : `Reduce vacancy in ${keyLabel(log.toKey)} from ${log.vacToBefore} to ${log.vacToBefore - 1}. Increase vacancy in ${keyLabel(log.fromKey)} from ${log.vacFromBefore} to ${log.vacFromBefore + 1}.`;
            return line1 + '\n' + line2;
        } else if (log.step === 'A' && log.stayed) {
            return `Remain in current position.`;
        } else if (log.step === 'B') {
            return `Remain in current position.`;
        } else if (log.step === 'C') {
            const line1 = `Section 24 Displacement — ${posLabel(log.toKey)}. ${fmtSource(log.source)}${bumpNote}`;
            const line2 = log.displacementBump
                ? `Displacement move — no vacancy consumed in ${keyLabel(log.toKey)}. Increase vacancy in ${keyLabel(log.fromKey)} from ${log.vacFromBefore} to ${log.vacFromBefore + 1}.`
                : `Reduce vacancy in ${keyLabel(log.toKey)} from ${log.vacToBefore} to ${log.vacToBefore - 1}. Increase vacancy in ${keyLabel(log.fromKey)} from ${log.vacFromBefore} to ${log.vacFromBefore + 1}.`;
            return line1 + '\n' + line2;
        } else if (log.step === 'D') {
            if (log.selfDisp) {
                return `Bid request does not meet BPL requirement. Requested BPL = ${log.bplLimit}. BPL if awarded = ${log.bplRank}.`;
            } else {
                return `Displaced: No position available — system-wide reduction. Increase vacancy in ${keyLabel(log.fromKey)} from ${log.vacFromBefore} to ${log.vacFromBefore + 1}.`;
            }
        }
        return "No bid data.";
    }

    // ── STAMP REASON ON EACH AUDIT TRAIL ENTRY ───────────────────────────────
    auditTrail.forEach(entry => {
        entry.reason = buildReasonFromLog(entry.log);
    });

    // ── BUILD FINAL AWARDED REASON STRINGS ───────────────────────────────────
    bidders.forEach(p => {
        const log = p.moveLog;
        if (!log) { p.awardedReason = "No bid data."; return; }
        p.awardedReason = buildReasonFromLog(log);
    });

    return { roster: bidders, loops, auditTrail, bidTransactions, targetMap, finalVacancies: vacancies };
}
