/**
 * AIRLINE BID ENGINE - 3-PHASE SECTION 24 TRANSACTION LOG EDITION
 * Phase 1: Vacancy Fill & Upward Proffering (Open Positions & Retirees)
 * Phase 2: System Reductions (Apply Negative Deltas, Force Out Juniors)
 * Phase 3: Section 24 Displacement Bumping Rights & Cascade
 */
function runBidEngine(data, deltaMap) {
    const auditTrail = [];
    const is737 = (p) => p.current && p.current.equip === "737";

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

    // ── HEADCOUNT & TARGET MAP ───────────────────────────────────────────────
    let liveHeadcount = {};
    activeBidders.forEach(p => {
        const key = `${p.current.base}-${p.current.seat}`.toUpperCase();
        liveHeadcount[key] = (liveHeadcount[key] || 0) + 1;
    });

    let targetMap = {};
    let vacPool = {};

    Object.keys(liveHeadcount).forEach(key => {
        targetMap[key] = liveHeadcount[key] + (deltaMap[key] || 0);
        vacPool[key] = Math.max(0, deltaMap[key] || 0);
    });
    
    data.caps.forEach(c => {
        const key = `${c.base}-${c.seat}`.toUpperCase();
        if (targetMap[key] === undefined) {
            targetMap[key] = c.startCapacity + (deltaMap[key] || 0);
            vacPool[key] = Math.max(0, deltaMap[key] || 0);
        }
    });

    // Add retirees to vacancy pool
    (data.retired || []).forEach(r => {
        if (r.base && r.seat) {
            const key = `${r.base}-${r.seat}`.toUpperCase();
            vacPool[key] = (vacPool[key] || 0) + 1;
        }
    });

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

    let txId = 0;
    let assignments = {};
    bidders.forEach(b => assignments[b.sen] = b.orig);

    // ── PHASE 1: VACANCY FILL & UPWARD PROFFERING ────────────────────────────
    function tryAward(sen, target, prefOrder) {
        const p = bidders.find(b => b.sen === sen);
        const pr = p.prefs.find(x => x.targetKey === target) || { order: prefOrder, bpl: 9999 };
        
        let rank = 1;
        for (const other of bidders) {
            if (other.sen >= sen) break;
            if (assignments[other.sen] === target) rank++;
        }

        const isMoving = (assignments[sen] !== target);

        if (rank > pr.bpl) {
            p.failedPrefs.push({ order: pr.order, targetKey: target, reason: 'BPL requirement not met.' });
            auditTrail.push({
                txId: txId++, sen: p.sen, name: p.name, from: assignments[sen], to: `737 ${target.replace('-', ' ')}`,
                log: { step: 'DENY', prefOrder: pr.order, toKey: target, reason: 'BPL requirement not met.' }
            });
            return false;
        }

        if (isMoving && vacPool[target] <= 0) {
            p.failedPrefs.push({ order: pr.order, targetKey: target, reason: 'Requested position has 0 vacancy and cannot accept additional pilots.' });
            auditTrail.push({
                txId: txId++, sen: p.sen, name: p.name, from: assignments[sen], to: `737 ${target.replace('-', ' ')}`,
                log: { step: 'DENY', prefOrder: pr.order, toKey: target, reason: 'Requested position has 0 vacancy and cannot accept additional pilots.' }
            });
            return false;
        }

        if (isMoving) {
            vacPool[target]--;
            const oldSeat = assignments[sen];
            assignments[sen] = target;
            p.currentKey = target;
            p.awardedPrefNum = pr.order;

            const noteText = `Open position available. Reduce vacancy in 73G ${target.replace('-', ' ')} from ${vacPool[target]+1} to ${vacPool[target]}. Increase vacancy in 73G ${oldSeat.replace('-', ' ')}.`;
            auditTrail.push({
                txId: txId++, sen: p.sen, name: p.name, from: `737 ${oldSeat.replace('-', ' ')}`, to: `737 ${target.replace('-', ' ')}`,
                log: { step: 'A', prefOrder: pr.order, fromKey: oldSeat, toKey: target, note: noteText, source: { type: 'vacancy', label: 'open position' } }
            });

            if (oldSeat !== target) {
                vacPool[oldSeat] = (vacPool[oldSeat] || 0) + 1;
                profferSlot(oldSeat, sen);
            }
        } else {
            p.awardedPrefNum = pr.order;
            p.currentKey = target;
            auditTrail.push({
                txId: txId++, sen: p.sen, name: p.name, from: `737 ${target.replace('-', ' ')}`, to: `737 ${target.replace('-', ' ')}`,
                log: { step: 'A', prefOrder: pr.order, stayed: true, toKey: target }
            });
        }
        return true;
    }

    function profferSlot(slotKey, vacatedBySen) {
        for (const other of bidders) {
            if (other.sen >= vacatedBySen) break;
            const currTarget = assignments[other.sen];
            const currIdx = other.prefs.findIndex(x => x.targetKey === currTarget);
            const slotIdx = other.prefs.findIndex(x => x.targetKey === slotKey);
            
            if (slotIdx !== -1 && (currIdx === -1 || slotIdx < currIdx)) {
                const pr = other.prefs[slotIdx];
                if (tryAward(other.sen, slotKey, pr.order)) return;
            }
        }
    }

    bidders.forEach(p => {
        let awarded = false;
        for (const pr of p.prefs) {
            if (!pr.targetKey) continue;
            if (tryAward(p.sen, pr.targetKey, pr.order)) {
                awarded = true;
                break;
            }
        }
        if (!awarded) {
            auditTrail.push({
                txId: txId++, sen: p.sen, name: p.name, from: `737 ${p.orig.replace('-', ' ')}`, to: `737 ${p.orig.replace('-', ' ')}`,
                log: { step: 'HOLD', stayed: true, toKey: p.orig }
            });
        }
    });

    bidders.forEach(p => p.currentKey = assignments[p.sen]);

    // ── PHASE 2: REDUCTIONS ──────────────────────────────────────────────────
    const displacedQueue = [];
    
    // Calculate minimum position seniority for reduction bounds
    const minSensAtCap = {};
    Object.keys(targetMap).forEach(key => {
        const cap = targetMap[key];
        const atKey = bidders.filter(b => b.currentKey === key).sort((a, b) => a.sen - b.sen);
        if (atKey.length > cap) {
            minSensAtCap[key] = atKey[cap - 1].sen;
        }
    });

    Object.keys(targetMap).forEach(key => {
        const cap = targetMap[key];
        const atKey = bidders.filter(b => b.currentKey === key).sort((a, b) => a.sen - b.sen);
        const over = atKey.length - cap;
        if (over > 0) {
            const bumped = atKey.slice(-over);
            bumped.forEach(p => {
                p.isForceDisplaced = true;
                p.reductionEvents.push({ fromKey: key, minSen: p.sen, loop: 2 });
                displacedQueue.push(p);
                
                const minSen = minSensAtCap[key] || p.sen;
                auditTrail.push({
                    txId: txId++, sen: p.sen, name: p.name, from: `737 ${key.replace('-', ' ')}`, to: `737 ${key.replace('-', ' ')}`,
                    log: { step: 'RED', fromKey: key, toKey: key, forcedOut: true, minSen }
                });
            });
        }
    });

    // ── PHASE 3: SECTION 24 DISPLACEMENT CASCADE ─────────────────────────────
    let cascadePhase3 = true;
    let p3Loops = 0;
    while (cascadePhase3 && displacedQueue.length > 0 && p3Loops < 5000) {
        cascadePhase3 = false;
        p3Loops++;
        displacedQueue.sort((a, b) => a.sen - b.sen);
        const stillDisplaced = [];
        const bumpedThisRound = new Set();

        for (const p of displacedQueue) {
            let awarded = false;
            let newSeat = null;
            let bumpedPilot = null;
            let log = null;
            let prefNum = "N/A";

            // Try Preferences with Bump Rights
            for (const pr of p.prefs) {
                if (!pr.targetKey) continue;
                const targetKey = pr.targetKey;
                const cap = targetMap[targetKey] || 0;

                let rank = 1;
                for (const other of bidders) {
                    if (other.sen >= p.sen) break;
                    if (other.currentKey === targetKey) rank++;
                }

                if (rank > pr.bpl) {
                    auditTrail.push({
                        txId: txId++, sen: p.sen, name: p.name, from: `737 ${p.currentKey.replace('-', ' ')}`, to: `737 ${targetKey.replace('-', ' ')}`,
                        log: { step: 'DENY', prefOrder: pr.order, toKey: targetKey, reason: 'BPL requirement not met.' }
                    });
                    continue;
                }
                if (rank > cap) {
                    auditTrail.push({
                        txId: txId++, sen: p.sen, name: p.name, from: `737 ${p.currentKey.replace('-', ' ')}`, to: `737 ${targetKey.replace('-', ' ')}`,
                        log: { step: 'DENY', prefOrder: pr.order, toKey: targetKey, reason: 'Seniority is not high enough to hold position.' }
                    });
                    continue;
                }

                const hasVac = vacPool[targetKey] > 0;
                const junior = mostJuniorAt(targetKey, p.sen);
                const canBump = junior !== null && p.sen < junior.sen && !bumpedThisRound.has(junior.sen);

                if (hasVac || canBump) {
                    newSeat = targetKey;
                    prefNum = pr.order;
                    awarded = true;

                    if (hasVac) {
                        vacPool[targetKey]--;
                    } else if (canBump) {
                        bumpedPilot = junior;
                        bumpedPilot.isForceDisplaced = true;
                        bumpedThisRound.add(bumpedPilot.sen);
                        stillDisplaced.push(bumpedPilot);

                        auditTrail.push({
                            txId: txId++, sen: bumpedPilot.sen, name: bumpedPilot.name, from: `737 ${targetKey.replace('-', ' ')}`, to: `737 ${targetKey.replace('-', ' ')}`,
                            log: { step: 'DISP', fromKey: targetKey, toKey: targetKey, displacedBy: `${p.sen} - ${p.name}` }
                        });
                    }

                    log = {
                        step: 'C', prefOrder: pr.order, fromKey: p.currentKey, toKey: targetKey,
                        source: bumpedPilot ? { type: 'pilot', sen: bumpedPilot.sen, name: bumpedPilot.name } : { type: 'vacancy', label: 'open position' },
                        displacementBump: !!bumpedPilot, bumpedSen: bumpedPilot ? bumpedPilot.sen : null, forcedOut: true
                    };
                    break;
                }
            }

            // Fallback Section 24 Order
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

                    const hasVac = vacPool[targetKey] > 0;
                    const junior = mostJuniorAt(targetKey, p.sen);
                    const canBump = junior !== null && p.sen < junior.sen && !bumpedThisRound.has(junior.sen);

                    if (hasVac || canBump) {
                        newSeat = targetKey;
                        awarded = true;

                        if (hasVac) {
                            vacPool[targetKey]--;
                        } else if (canBump) {
                            bumpedPilot = junior;
                            bumpedPilot.isForceDisplaced = true;
                            bumpedThisRound.add(bumpedPilot.sen);
                            stillDisplaced.push(bumpedPilot);

                            auditTrail.push({
                                txId: txId++, sen: bumpedPilot.sen, name: bumpedPilot.name, from: `737 ${targetKey.replace('-', ' ')}`, to: `737 ${targetKey.replace('-', ' ')}`,
                                log: { step: 'DISP', fromKey: targetKey, toKey: targetKey, displacedBy: `${p.sen} - ${p.name}` }
                            });
                        }

                        log = {
                            step: 'C', fromKey: p.currentKey, toKey: targetKey,
                            source: bumpedPilot ? { type: 'pilot', sen: bumpedPilot.sen, name: bumpedPilot.name } : { type: 'vacancy', label: 'open position' },
                            displacementBump: !!bumpedPilot, bumpedSen: bumpedPilot ? bumpedPilot.sen : null, forcedOut: true
                        };
                        break;
                    }
                }
            }

            if (!awarded) {
                newSeat = "UNASSIGNED";
                log = { step: 'D', fromKey: p.currentKey, toKey: 'UNASSIGNED', forcedOut: true };
                stillDisplaced.push(p);
            }

            p.awardedPrefNum = prefNum;
            p.moveLog = log;
            p.isForceDisplaced = false;

            if (newSeat !== p.currentKey) {
                const prevKey = p.currentKey;
                p.currentKey = newSeat;
                auditTrail.push({
                    txId: txId++, sen: p.sen, name: p.name, from: `737 ${prevKey.replace('-', ' ')}`, to: `737 ${newSeat.replace('-', ' ')}`,
                    log
                });
                cascadePhase3 = true;
                break;
            }
        }
        displacedQueue.length = 0;
        displacedQueue.push(...stillDisplaced);
    }

    // ── REASON FORMATTER ─────────────────────────────────────────────────────
    function buildReason(log) {
        if (!log) return "Remain in current position.";
        if (log.step === 'DENY') return log.reason || "Requested position has 0 vacancy and cannot accept additional pilots.";
        if (log.step === 'RED') return `Seniority is not high enough to hold position due to reductions. Minimum position seniority is ${log.minSen}.`;
        if (log.step === 'DISP') return `Could not hold base with seniority. Displaced by ${log.displacedBy}.`;
        if (log.displacementBump && log.bumpedSen) {
            return `No vacancy, but seniority holds base. Award due to Reduction/Displacement. Displace ${log.bumpedSen} - ${log.source.name}.`;
        }
        if (log.source && log.source.type === 'vacancy') {
            return `Open position available. Awarded preference #${log.prefOrder || 1}.`;
        }
        return "Awarded.";
    }

    auditTrail.forEach(e => e.reason = buildReason(e.log));
    bidders.forEach(p => {
        p.moved = p.currentKey !== p.orig;
        p.isUnassigned = p.currentKey === "UNASSIGNED";
        p.awardedReason = buildReason(p.moveLog);
    });

    return { roster: bidders, loops: p3Loops, auditTrail, targetMap };
}
