/**
 * AIRLINE BID ENGINE - LIVE LEDGER EDITION (BPL Tracking Update)
 * FIXED: Home Base Protection & Active-Only Headcount Purge.
 */
function runBidEngine(data, deltaMap) {
    const auditTrail = [];
    const is737 = (p) => p.current && p.current.equip === "737";
    
    // 1. FAST LOOKUP SETS
    // Removed the is737 check here because the retired/nobid JSONs do not have the nested 'current' object.
    const retiredSens = new Set(data.retired.map(p => p.seniority || p.sen));
    const noBidSens   = new Set(data.noBid.map(p => p.sen));

    // 2. PURGE RETIRED/NO-BID
    // Only active pilots participate in the bid and occupy seats.
    const activeBidders = data.roster.filter(p =>
        is737(p) && !retiredSens.has(p.sen) && !noBidSens.has(p.sen)
    );

    const baseNames = {
        ANC: 'Anchorage', SEA: 'Seattle',       LAX: 'Los Angeles',
        SAN: 'San Diego', SFO: 'San Francisco',  PDX: 'Portland',
        LAS: 'Las Vegas'
    };
    const seatNames = { CA: 'Captain', FO: 'First Officer' };

    function keyLabel(key) {
        const [base, seat] = (key || '').split('-');
        return `${base} ${seat}`;
    }

    function posLabel(key) {
        const [base, seat] = (key || '').split('-');
        return `${baseNames[base] || base} ${seatNames[seat] || seat}`;
    }

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
        if (src.type === 'pilot') return `Proffered from Sen #${src.sen} - ${src.name}.`;
        return `Open position available (${src.label}).`;
    }

    // 3. CALCULATE LIVE HEADCOUNT FROM ACTIVE ONLY
    let liveHeadcount = {};
    activeBidders.forEach(p => {
        const key = `${p.current.base}-${p.current.seat}`.toUpperCase();
        liveHeadcount[key] = (liveHeadcount[key] || 0) + 1;
    });

    // 4. TARGET MAP (CAPACITY)
    let targetMap = {};
    activeBidders.forEach(p => {
        const key = `${p.current.base}-${p.current.seat}`.toUpperCase();
        if (targetMap[key] === undefined) {
             targetMap[key] = liveHeadcount[key] + (deltaMap[key] || 0);
        }
    });
    data.caps.forEach(c => {
        const key = `${c.base}-${c.seat}`.toUpperCase();
        if (targetMap[key] === undefined) {
            targetMap[key] = c.startCapacity + (deltaMap[key] || 0);
        }
    });

    Object.keys(targetMap).forEach(key => {
        const preExisting = (targetMap[key] || 0) - (liveHeadcount[key] || 0);
        slotSources[key] = [];
        for (let i = 0; i < preExisting; i++) {
            slotSources[key].push({ type: 'vacancy', label: 'retirement / system reduction' });
        }
    });

    let currentCounts = { ...liveHeadcount };
    const getVac = (key) => (targetMap[key] || 0) - (currentCounts[key] || 0);

    const bidders = activeBidders.map(p => {
        const prefData  = data.prefs['pil' + p.sen] || data.prefs[p.id] || { preferences: [] };
        const pilotOrig = `${p.current.base}-${p.current.seat}`.toUpperCase();

        const getTargetKey = (bidStr) => {
            const parts = bidStr.trim().toUpperCase().split(/\s+/);
            const bases = ['ANC', 'SEA', 'LAX', 'SAN', 'SFO', 'PDX', 'LAS'];
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
            moveLog: null,
            prefs: (prefData.preferences || []).map(pr => {
                let limit = parseInt(pr.bpl || pr.bpl_min);
                if (isNaN(limit) || limit === 0) limit = 9999;
                return { ...pr, targetKey: getTargetKey(pr.bid), bpl: limit };
            }).sort((a, b) => a.order - b.order)
        };
    }).sort((a, b) => a.sen - b.sen);

    let cascade = true;
    let loops   = 0;

    while (cascade) {
        cascade = false;
        loops++;

        for (let i = 0; i < bidders.length; i++) {
            const p = bidders[i];
            let awarded  = false;
            let newSeat  = null;
            let log      = null;
            let prefNum  = "N/A";
            let selfDisp = false;
            let failedPrefs = []; 
            const [origBase, origStatus] = p.orig.split('-');

            for (const pr of p.prefs) {
                if (!pr.targetKey) continue;
                const targetKey  = pr.targetKey;
                const cap        = targetMap[targetKey] || 0;

                // HOME BASE PROTECTION
                const isGoingHome = (targetKey === p.orig);
                const isMovingIn  = (p.currentKey !== targetKey);

                let rank = 1;
                for (const other of bidders) {
                    if (other.sen >= p.sen) break;
                    if (other.currentKey === targetKey) rank++;
                }

                // A pilot never needs a vacancy to stay in or return to their original base.
                const vacancyOk = isGoingHome ? true : (isMovingIn ? getVac(targetKey) > 0 : true);

                if (rank > pr.bpl) {
                    failedPrefs.push(`Pref #${pr.order} (${keyLabel(targetKey)}) skipped: Rank ${rank} exceeds BPL ${pr.bpl}.`);
                } else if (rank > cap) {
                    failedPrefs.push(`Pref #${pr.order} (${keyLabel(targetKey)}) skipped: Rank ${rank} exceeds Capacity ${cap}.`);
                } else if (!isGoingHome && isMovingIn && !vacancyOk) {
                    failedPrefs.push(`Pref #${pr.order} (${keyLabel(targetKey)}) skipped: No vacancy.`);
                }

                if (rank <= pr.bpl && rank <= cap && vacancyOk) {
                    newSeat = targetKey;
                    prefNum = pr.order;
                    awarded = true;

                    if (!isGoingHome && isMovingIn) {
                        const src = consumeSlot(targetKey);
                        log = {
                            step: 'A', prefOrder: pr.order, fromKey: p.currentKey, toKey: targetKey,
                            vacFromBefore: getVac(p.currentKey), vacToBefore: getVac(targetKey),
                            source: src, failedPrefs
                        };
                    } else {
                        log = { step: 'A', prefOrder: pr.order, fromKey: null, toKey: targetKey, stayed: true, failedPrefs };
                    }
                    break;
                }
            }

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
                    log = { step: 'B', fromKey: null, toKey: p.orig, stayed: true, failedPrefs };
                }
            }

            if (!awarded) {
                const cascadeOptions = [
                    ...['ANC', 'SEA', 'LAX', 'SAN', 'SFO', 'PDX', 'LAS']
                        .filter(b => b !== origBase).map(b => `${b}-${origStatus}`),
                    `${origBase}-FO`,
                    ...['ANC', 'SEA', 'LAX', 'SAN', 'SFO', 'PDX', 'LAS']
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

                    const vacancyOk = isMovingIn ? getVac(targetKey) > 0 : true;

                    if (rank <= cap && vacancyOk) {
                        newSeat = targetKey;
                        awarded = true;
                        
                        if (isMovingIn) {
                            const src = consumeSlot(targetKey);
                            log = {
                                step: 'C', fromKey: p.currentKey, toKey: targetKey,
                                vacFromBefore: getVac(p.currentKey), vacToBefore: getVac(targetKey),
                                source: src, failedPrefs
                            };
                        } else {
                            log = { step: 'C', fromKey: null, toKey: targetKey, stayed: true, failedPrefs };
                        }
                        break; 
                    }
                }
            }

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
                    step: 'D', fromKey: p.currentKey, toKey: 'UNASSIGNED',
                    vacFromBefore: getVac(p.currentKey), selfDisp,
                    bplRank: rank, bplLimit: selfBid ? selfBid.bpl : null,
                    origKey: p.orig, failedPrefs
                };
            }

            p.awardedPrefNum   = prefNum;
            p.wasSelfDisplaced = selfDisp;
            p.moveLog          = log;

            if (newSeat !== p.currentKey) {
                if (p.currentKey !== "UNASSIGNED") {
                    releaseSlot(p.currentKey, p.sen, p.name);
                    currentCounts[p.currentKey]--;
                }
                if (newSeat !== "UNASSIGNED") {
                    currentCounts[newSeat] = (currentCounts[newSeat] || 0) + 1;
                }

                p.currentKey   = newSeat;
                p.moved        = (newSeat !== p.orig);
                p.isUnassigned = (newSeat === "UNASSIGNED");

                auditTrail.push({ loop: loops, sen: p.sen, name: p.name, to: newSeat, log });
                cascade = true;
                break;
            } else {
                p.moved        = (p.currentKey !== p.orig);
                p.isUnassigned = (p.currentKey === "UNASSIGNED");
            }
        }
        if (loops > 10000) break;
    }

    bidders.forEach(p => {
        const log = p.moveLog;
        if (!log) { p.awardedReason = "No bid data."; return; }

        const failedStr = (log.failedPrefs && log.failedPrefs.length > 0) 
            ? ` ${log.failedPrefs.join(' ')}` : '';
        const finalVac = (key) => (targetMap[key] || 0) - (currentCounts[key] || 0);

        if (log.step === 'A' && !log.stayed) {
            p.awardedReason = `Awarded Pref #${log.prefOrder} \u2014 ${posLabel(log.toKey)}.${failedStr} ${fmtSource(log.source)} Reduce vacancy in ${keyLabel(log.toKey)} from ${log.vacToBefore} to ${log.vacToBefore - 1}. Increase vacancy in ${keyLabel(log.fromKey)} from ${log.vacFromBefore} to ${log.vacFromBefore + 1}.`;
        } else if (log.step === 'A' && log.stayed) {
            p.awardedReason = `Awarded Pref #${log.prefOrder} \u2014 Remained in ${posLabel(log.toKey)}.${failedStr} ${keyLabel(log.toKey)} vacancy: ${finalVac(log.toKey)} open of ${targetMap[log.toKey] || 0}.`;
        } else if (log.step === 'B') {
            p.awardedReason = `Held Position (Seniority) \u2014 ${posLabel(log.toKey)}.${failedStr} ${keyLabel(log.toKey)} vacancy: ${finalVac(log.toKey)} open of ${targetMap[log.toKey] || 0}.`;
        } else if (log.step === 'C') {
            p.awardedReason = `Section 24 Displacement \u2192 ${posLabel(log.toKey)}.${failedStr} ${fmtSource(log.source)} Reduce vacancy in ${keyLabel(log.toKey)} from ${log.vacToBefore} to ${log.vacToBefore - 1}. Increase vacancy in ${keyLabel(log.fromKey)} from ${log.vacFromBefore} to ${log.vacFromBefore + 1}.`;
        } else if (log.step === 'D') {
            p.awardedReason = log.selfDisp 
                ? `BPL Failure \u2014 Rank ${log.bplRank} exceeds limit of ${log.bplLimit} for ${posLabel(log.origKey)}.${failedStr} Increase vacancy in ${keyLabel(log.fromKey)} from ${log.vacFromBefore} to ${log.vacFromBefore + 1}.`
                : `Displaced: System-wide reduction.${failedStr} Increase vacancy in ${keyLabel(log.fromKey)} from ${log.vacFromBefore} to ${log.vacFromBefore + 1}.`;
        }
    });

    return { roster: bidders, loops, auditTrail, targetMap };
}
