/**
 * AIRLINE BID ENGINE - 3-PHASE SECTION 24 CASCADE EDITION
 * Phase 1: Vacancy Fill (Positive Deltas Only)
 * Phase 2: System Reductions (Apply Negative Deltas, Force Out Juniors)
 * Phase 3: Displacement Rights (Section 24 Bumps & Fallbacks)
 */
function runBidEngine(data, deltaMap) {
    const auditTrail = [];
    const is737 = (p) => p.current && p.current.equip === "737";

    // Exclude retired and no-bid pilots entirely from this snapshot
    const retiredSens = new Set(data.retired.map(p => p.sen || p.seniority));
    const noBidSens   = new Set(data.noBid.map(p => p.sen || p.seniority));

    const activeBidders = data.roster.filter(p =>
        is737(p) && !retiredSens.has(p.sen) && !noBidSens.has(p.sen)
    );

    const baseNames = { ANC: 'Anchorage', SEA: 'Seattle', LAX: 'Los Angeles', SAN: 'San Diego', SFO: 'San Francisco', PDX: 'Portland' };
    const seatNames = { CA: 'Captain', FO: 'First Officer' };

    function keyLabel(key) { return key ? key.replace('-', ' ') : ''; }
    function posLabel(key) {
        const [base, seat] = (key || '').split('-');
        return `${baseNames[base] || base} ${seatNames[seat] || seat}`;
    }

    // Live Headcount
    let liveHeadcount = {};
    activeBidders.forEach(p => {
        const key = `${p.current.base}-${p.current.seat}`.toUpperCase();
        liveHeadcount[key] = (liveHeadcount[key] || 0) + 1;
    });

    // Target Capacities
    let targetMap = {};
    Object.keys(liveHeadcount).forEach(key => {
        targetMap[key] = liveHeadcount[key] + (deltaMap[key] || 0);
    });
    data.caps.forEach(c => {
        const key = `${c.base}-${c.seat}`.toUpperCase();
        if (targetMap[key] === undefined) {
            targetMap[key] = c.startCapacity + (deltaMap[key] || 0);
        }
    });

    let currentCounts = { ...liveHeadcount };
    const getVac = (key) => (targetMap[key] || 0) - (currentCounts[key] || 0);

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

    function mostJuniorAt(key, excludeSen) {
        for (let i = bidders.length - 1; i >= 0; i--) {
            if (bidders[i].currentKey === key && bidders[i].sen !== excludeSen) return bidders[i];
        }
        return null;
    }

    let loops = 0;

    // ── PHASE 1: VACANCY RUN ─────────────────────────────────────────────────
    // Everyone bids in seniority order. ONLY actual vacancies are consumed.
    // No displacement, no bumping. If no vacancy, pilot holds current.
    let cascadePhase1 = true;
    while (cascadePhase1 && loops < 1000) {
        cascadePhase1 = false;
        loops++;

        for (let i = 0; i < bidders.length; i++) {
            const p = bidders[i];
            let awardedPhase1 = false;

            for (const pr of p.prefs) {
                if (!pr.targetKey) continue;
                const targetKey = pr.targetKey;
                const isMovingIn = (p.currentKey !== targetKey);

                let rank = 1;
                for (const other of bidders) {
                    if (other.sen >= p.sen) break;
                    if (other.currentKey === targetKey) rank++;
                }

                if (rank > pr.bpl || rank > (targetMap[targetKey] || 0)) {
                    p.failedPrefs.push({ order: pr.order, targetKey, reason: 'Does not meet BPL or Capacity requirement.', loop: loops });
                    continue;
                }

                if (isMovingIn && getVac(targetKey) <= 0) {
                    p.failedPrefs.push({ order: pr.order, targetKey, reason: 'Requested position has 0 vacancy and cannot accept additional pilots.', loop: loops });
                    continue;
                }

                if (isMovingIn) {
                    const prevKey = p.currentKey;
                    currentCounts[prevKey]--;
                    currentCounts[targetKey]++;
                    p.currentKey = targetKey;
                    
                    p.moveLog = {
                        step: 'A', prefOrder: pr.order, fromKey: prevKey, toKey: targetKey,
                        vacFromBefore: getVac(prevKey)-1, vacToBefore: getVac(targetKey)+1,
                        source: { type: 'vacancy', label: 'open position available' },
                        displacementBump: false, forcedOut: false
                    };
                    p.awardedPrefNum = pr.order;
                    cascadePhase1 = true;
                    awardedPhase1 = true;
                    auditTrail.push({ loop: loops, sen: p.sen, name: p.name, from: prevKey, to: targetKey, log: p.moveLog });
                } else if (p.currentKey === p.orig && !p.moveLog) {
                    p.moveLog = { step: 'A', prefOrder: pr.order, fromKey: null, toKey: targetKey, stayed: true, forcedOut: false };
                    awardedPhase1 = true;
                }
                break; // Move awarded or held, stop checking prefs
            }
            if (cascadePhase1) break; // Restart loop if a move happened
        }
    }

    // ── PHASE 2: REDUCTIONS & IDENTIFY DISPLACED ─────────────────────────────
    const displacedPilots = [];
    
    Object.keys(targetMap).forEach(key => {
        const cap = targetMap[key];
        const atKey = bidders.filter(p => p.currentKey === key).sort((a, b) => a.sen - b.sen);
        const over = atKey.length - cap;
        
        if (over > 0) {
            const displacedHere = atKey.slice(-over);
            displacedHere.forEach(p => {
                p.isForceDisplaced = true;
                p.reductionEvents.push({ fromKey: key, minSen: p.sen, loop: loops });
                displacedPilots.push(p);
            });
        }
    });

    // ── PHASE 3: DISPLACEMENT / BUMP CASCADE ─────────────────────────────────
    let cascadePhase3 = true;
    while (cascadePhase3 && displacedPilots.length > 0) {
        cascadePhase3 = false;
        loops++;
        
        displacedPilots.sort((a, b) => a.sen - b.sen);
        const stillDisplaced = [];
        const bumpedThisRound = new Set();

        for (const p of displacedPilots) {
            let awarded = false;
            let newSeat = null;
            let bumpedPilot = null;
            let log = null;
            let prefNum = "N/A";

            // Step A: Voluntary Prefs w/ Bump Rights
            for (const pr of p.prefs) {
                if (!pr.targetKey) continue;
                const targetKey = pr.targetKey;
                const cap = targetMap[targetKey] || 0;
                const isMovingIn = (p.currentKey !== targetKey);

                let rank = 1;
                for (const other of bidders) {
                    if (other.sen >= p.sen) break;
                    if (other.currentKey === targetKey) rank++;
                }

                const hasVac = getVac(targetKey) > 0;
                const junior = mostJuniorAt(targetKey, p.sen);
                const canBump = junior !== null && p.sen < junior.sen && !bumpedThisRound.has(junior.sen);

                if (rank > pr.bpl || rank > cap) {
                    p.failedPrefs.push({ order: pr.order, targetKey, reason: 'Does not meet BPL or Cap requirement.', loop: loops });
                    continue;
                }
                
                if (!hasVac && !canBump) {
                    p.failedPrefs.push({ order: pr.order, targetKey, reason: 'Requested position has 0 vacancy and cannot accept additional pilots.', loop: loops });
                    continue;
                }

                newSeat = targetKey;
                prefNum = pr.order;
                awarded = true;

                if (isMovingIn) {
                    if (!hasVac && canBump) {
                        bumpedPilot = junior;
                        bumpedPilot.isForceDisplaced = true;
                        bumpedThisRound.add(bumpedPilot.sen);
                        stillDisplaced.push(bumpedPilot);
                    }
                }

                log = {
                    step: 'A', prefOrder: pr.order, fromKey: p.currentKey, toKey: targetKey,
                    vacFromBefore: getVac(p.currentKey), vacToBefore: getVac(targetKey),
                    source: bumpedPilot ? { type: 'pilot', sen: bumpedPilot.sen, name: bumpedPilot.name } : { type: 'vacancy', label: 'open position available' },
                    displacementBump: !!bumpedPilot, bumpedSen: bumpedPilot ? bumpedPilot.sen : null, forcedOut: true
                };
                break;
            }

            // Step B: Hold Orig (if wasn't awarded a pref)
            if (!awarded) {
                const targetKey = p.orig;
                const cap = targetMap[targetKey] || 0;
                const hasVac = getVac(targetKey) > 0;
                const junior = mostJuniorAt(targetKey, p.sen);
                const canBump = junior !== null && p.sen < junior.sen && !bumpedThisRound.has(junior.sen);

                let rank = 1;
                for (const other of bidders) {
                    if (other.sen >= p.sen) break;
                    if (other.currentKey === targetKey) rank++;
                }
                const selfBid = p.prefs.find(pr => pr.targetKey === targetKey);
                const bplLimit = selfBid ? selfBid.bpl : 9999;

                if (rank <= bplLimit && rank <= cap && (hasVac || canBump)) {
                    newSeat = targetKey;
                    awarded = true;
                    if (!hasVac && canBump) {
                        bumpedPilot = junior;
                        bumpedPilot.isForceDisplaced = true;
                        bumpedThisRound.add(bumpedPilot.sen);
                        stillDisplaced.push(bumpedPilot);
                    }
                    log = { step: 'B', fromKey: p.currentKey, toKey: targetKey, stayed: true, forcedOut: true, displacementBump: !!bumpedPilot };
                }
            }

            // Step C: Section 24 Fallback Options
            if (!awarded) {
                const [origBase, origStatus] = p.orig.split('-');
                const cascadeOptions = [
                    `${origBase}-${origStatus}`,
                    ...['ANC', 'SEA', 'LAX', 'SAN', 'SFO', 'PDX'].filter(b => b !== origBase).map(b => `${b}-${origStatus}`),
                    `${origBase}-FO`,
                    ...['ANC', 'SEA', 'LAX', 'SAN', 'SFO', 'PDX'].filter(b => b !== origBase).map(b => `${b}-FO`)
                ];

                for (const targetKey of cascadeOptions) {
                    if (targetMap[targetKey] === undefined) continue;
                    const cap = targetMap[targetKey] || 0;
                    
                    let rank = 1;
                    for (const other of bidders) {
                        if (other.sen >= p.sen) break;
                        if (other.currentKey === targetKey) rank++;
                    }
                    if (rank > cap) continue;

                    const hasVac = getVac(targetKey) > 0;
                    const junior = mostJuniorAt(targetKey, p.sen);
                    const canBump = junior !== null && p.sen < junior.sen && !bumpedThisRound.has(junior.sen);

                    if (hasVac || canBump) {
                        newSeat = targetKey;
                        awarded = true;
                        if (!hasVac && canBump) {
                            bumpedPilot = junior;
                            bumpedPilot.isForceDisplaced = true;
                            bumpedThisRound.add(bumpedPilot.sen);
                            stillDisplaced.push(bumpedPilot);
                        }
                        log = {
                            step: 'C', fromKey: p.currentKey, toKey: targetKey,
                            vacFromBefore: getVac(p.currentKey), vacToBefore: getVac(targetKey),
                            source: bumpedPilot ? { type: 'pilot', sen: bumpedPilot.sen, name: bumpedPilot.name } : { type: 'vacancy', label: 'open position available' },
                            displacementBump: !!bumpedPilot, bumpedSen: bumpedPilot ? bumpedPilot.sen : null, forcedOut: true
                        };
                        break;
                    }
                }
            }

            // Step D: Unassigned
            if (!awarded) {
                newSeat = "UNASSIGNED";
                log = { step: 'D', fromKey: p.currentKey, toKey: 'UNASSIGNED', forcedOut: true, selfDisp: false };
                stillDisplaced.push(p);
            }

            p.awardedPrefNum = prefNum;
            p.moveLog = log;
            p.isForceDisplaced = false;

            if (newSeat !== p.currentKey) {
                const prevKey = p.currentKey;
                if (prevKey !== "UNASSIGNED") currentCounts[prevKey]--;
                if (newSeat !== "UNASSIGNED") currentCounts[newSeat]++;
                
                p.currentKey = newSeat;
                auditTrail.push({ loop: loops, sen: p.sen, name: p.name, from: prevKey, to: newSeat, log });
                cascadePhase3 = true; 
                break; // Restart loop to handle newly bumped pilots in seniority order
            } else {
                p.reHoldEvents.push({ loop: loops, key: p.currentKey, log });
            }
        }
        
        displacedPilots.length = 0;
        displacedPilots.push(...stillDisplaced);
    }

    // ── FINAL LOGGING & REASON BUILDER ───────────────────────────────────────
    function fmtSource(src) {
        if (!src) return 'Source unknown.';
        if (src.type === 'pilot') return `Proffered from ${src.sen} - ${src.name}.`;
        return `Open position available.`;
    }

    function buildReasonFromLog(log) {
        if (!log) return "No bid data.";
        
        const bumpNote = (log.displacementBump && log.bumpedSen) ? ` Displace ${log.bumpedSen} - ${log.source.name}.` : '';
        const sec24Prefix = log.forcedOut ? `Award due to Reduction/Displacement. ` : '';

        if (log.step === 'A' && !log.stayed) {
            if (log.forcedOut && log.displacementBump) {
                return `No vacancy, but seniority holds base. Award due to Reduction/Displacement. Displace ${log.bumpedSen} - ${log.source.name}.`;
            }
            const vacText = log.displacementBump 
                ? `Displacement move.` 
                : `Reduce vacancy in 73G ${keyLabel(log.toKey)} from ${log.vacToBefore} to ${log.vacToBefore - 1}. Increase vacancy in 73G ${keyLabel(log.fromKey)} from ${log.vacFromBefore} to ${log.vacFromBefore + 1}.`;
            return `${fmtSource(log.source)} ${vacText}${bumpNote}`;
        } else if (log.step === 'A' && log.stayed) {
            return `Remain in current position.`;
        } else if (log.step === 'B') {
            return `Remain in current position.`;
        } else if (log.step === 'C') {
            if (log.forcedOut && log.displacementBump) {
                return `No vacancy, but seniority holds base. Award due to Reduction/Displacement. Displace ${log.bumpedSen} - ${log.source.name}.`;
            }
            return `Section 24 Displacement \u2014 ${posLabel(log.toKey)}. ${fmtSource(log.source)}${bumpNote}`;
        } else if (log.step === 'D') {
            return log.selfDisp ? `BPL Failure.` : `Could not hold base with seniority. Displaced.`;
        }
        return "No bid data.";
    }

    auditTrail.forEach(entry => entry.reason = buildReasonFromLog(entry.log));
    bidders.forEach(p => {
        p.moved = p.currentKey !== p.orig;
        p.isUnassigned = p.currentKey === "UNASSIGNED";
        
        // Format log correctly for final output
        if (p.moveLog) {
            p.awardedReason = buildReasonFromLog(p.moveLog);
            // Special check for being displaced specifically by someone
            if (p.isUnassigned && p.reductionEvents.length > 0) {
                 const takingAudit = auditTrail.slice().reverse().find(a => a.to === p.orig && a.sen < p.sen);
                 if (takingAudit) {
                     p.awardedReason = `Could not hold base with seniority. Displaced by ${takingAudit.sen} - ${takingAudit.name}`;
                 }
            }
        } else {
            p.awardedReason = p.moved ? "Awarded" : "Remain in current position.";
        }
    });

    return { roster: bidders, loops, auditTrail, targetMap };
}
