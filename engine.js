/**
- AIRLINE BID ENGINE - LIVE LEDGER EDITION (Displacement Chain Update)
- Logic Update: Force-displaced pilots do not need a vacancy to land.
- They bump the most junior pilot at their preferred base (where they
- outrank the junior-most). That bumped pilot inherits displacement rights
- and cascades the same way. Voluntary preference failures still require
- vacancies as before.
  */
  function runBidEngine(data, deltaMap) {
  const auditTrail = [];
  const is737 = (p) => p.current && p.current.equip === “737”;
  
  // ── FIXED PILOT EXCLUSION LOGIC ──────────────────────────────────────────
  const retiredSens = new Set(data.retired.map(p => p.sen || p.seniority));
  const noBidSens   = new Set(data.noBid.map(p => p.sen || p.seniority));
  
  const activeBidders = data.roster.filter(p =>
  is737(p) && !retiredSens.has(p.sen) && !noBidSens.has(p.sen)
  );
  
  // ── LABEL HELPERS ────────────────────────────────────────────────────────
  const baseNames = {
  ANC: ‘Anchorage’, SEA: ‘Seattle’,      LAX: ‘Los Angeles’,
  SAN: ‘San Diego’, SFO: ‘San Francisco’, PDX: ‘Portland’
  };
  const seatNames = { CA: ‘Captain’, FO: ‘First Officer’ };
  
  function keyLabel(key) {
  const [base, seat] = (key || ‘’).split(’-’);
  return `${base} ${seat}`;
  }
  
  function posLabel(key) {
  const [base, seat] = (key || ‘’).split(’-’);
  return `${baseNames[base] || base} ${seatNames[seat] || seat}`;
  }
  
  let slotSources = {};
  
  function consumeSlot(key) {
  if (!slotSources[key]) slotSources[key] = [];
  return slotSources[key].length > 0
  ? slotSources[key].shift()
  : { type: ‘vacancy’, label: ‘retirement / system reduction’ };
  }
  
  function releaseSlot(key, pilotSen, pilotName) {
  if (!slotSources[key]) slotSources[key] = [];
  slotSources[key].push({ type: ‘pilot’, sen: pilotSen, name: pilotName });
  }
  
  function fmtSource(src) {
  if (!src) return ‘Source unknown.’;
  if (src.type === ‘pilot’) return `Proffered from Sen #${src.sen} - ${src.name}.`;
  return `Open position available (${src.label}).`;
  }
  
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
  if (targetMap[key] === undefined) {
  targetMap[key] = c.startCapacity + (deltaMap[key] || 0);
  }
  });
  
  Object.keys(targetMap).forEach(key => {
  const preExisting = (targetMap[key] || 0) - (liveHeadcount[key] || 0);
  slotSources[key] = [];
  for (let i = 0; i < preExisting; i++) {
  slotSources[key].push({ type: ‘vacancy’, label: ‘retirement / system reduction’ });
  }
  });
  
  let currentCounts = { …liveHeadcount };
  const getVac = (key) => (targetMap[key] || 0) - (currentCounts[key] || 0);
  
  // ── BUILD BIDDER LIST ────────────────────────────────────────────────────
  const bidders = activeBidders.map(p => {
  const prefData  = data.prefs[‘pil’ + p.sen] || data.prefs[p.id] || { preferences: [] };
  const pilotOrig = `${p.current.base}-${p.current.seat}`.toUpperCase();
  
  ```
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
       isForceDisplaced: false,   // TRUE when the base shrank them out involuntarily
       moveLog: null,
       prefs: (prefData.preferences || []).map(pr => {
           let limit = parseInt(pr.bpl || pr.bpl_min);
           if (isNaN(limit) || limit === 0) limit = 9999;
           return { ...pr, targetKey: getTargetKey(pr.bid), bpl: limit };
       }).sort((a, b) => a.order - b.order)
   };
  ```
  
  }).sort((a, b) => a.sen - b.sen);
  
  // ── HELPER: is pilot force-displaced from their current base? ────────────
  // A pilot is force-displaced when the target capacity of their CURRENT base
  // is less than their rank there. This is an involuntary condition — the
  // base shrank beneath them. This is different from a BPL self-exclusion.
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
  
  ```
   for (let i = 0; i < bidders.length; i++) {
       const p = bidders[i];
       let awarded      = false;
       let newSeat      = null;
       let log          = null;
       let prefNum      = "N/A";
       let selfDisp     = false;
       let failedPrefs  = [];
       const [origBase, origStatus] = p.orig.split('-');
  
       // Determine whether this pilot is currently force-displaced from
       // wherever they are sitting right now.
       const forcedOut = isForceDisplacedFrom(p, p.currentKey);
  
       // ── STEP A: Work through submitted preferences ──────────────────
       for (const pr of p.prefs) {
           if (!pr.targetKey) continue;
           const targetKey  = pr.targetKey;
           const cap        = targetMap[targetKey] || 0;
           const isMovingIn = (p.currentKey !== targetKey);
  
           // Rank = how many senior pilots are already at targetKey + 1
           let rank = 1;
           for (const other of bidders) {
               if (other.sen >= p.sen) break;
               if (other.currentKey === targetKey) rank++;
           }
  
           // Vacancy check: force-displaced pilots do NOT need a vacancy —
           // they can bump the most junior pilot out of their chosen base.
           // Voluntary movers still need an open slot.
           let vacancyOk;
           if (forcedOut && isMovingIn) {
               // No vacancy required — just need to be senior to someone there,
               // OR there IS an open vacancy already.
               const junior = mostJuniorAt(targetKey, p.sen);
               vacancyOk = getVac(targetKey) > 0 || (junior !== null && p.sen < junior.sen);
           } else {
               vacancyOk = isMovingIn ? getVac(targetKey) > 0 : true;
           }
  
           if (rank > pr.bpl) {
               failedPrefs.push(`Pref #${pr.order} (${keyLabel(targetKey)}) skipped: Rank ${rank} exceeds BPL ${pr.bpl}.`);
           } else if (rank > cap) {
               failedPrefs.push(`Pref #${pr.order} (${keyLabel(targetKey)}) skipped: Rank ${rank} exceeds Capacity ${cap}.`);
           } else if (isMovingIn && !vacancyOk) {
               failedPrefs.push(`Pref #${pr.order} (${keyLabel(targetKey)}) skipped: No vacancy.`);
           }
  
           if (rank <= pr.bpl && rank <= cap && vacancyOk) {
               newSeat = targetKey;
               prefNum = pr.order;
               awarded = true;
  
               if (isMovingIn) {
                   const hasVac = getVac(targetKey) > 0;
                   let bumpedPilot = null;
  
                   if (forcedOut && !hasVac) {
                       // Displacement bump: find the most junior pilot there and
                       // mark them as force-displaced so they get the same rights.
                       bumpedPilot = mostJuniorAt(targetKey, p.sen);
                       if (bumpedPilot) {
                           bumpedPilot.isForceDisplaced = true;
                           bumpedPilot._lastBumperSen  = p.sen;
                           bumpedPilot._lastBumperName = p.name;
                           bumpedPilot._lastBumperFrom = p.currentKey;
                       }
                       // No slot consumed — we are displacing into an occupied seat.
                       log = {
                           step: 'A',
                           prefOrder: pr.order,
                           fromKey: p.currentKey,
                           toKey: targetKey,
                           vacFromBefore: getVac(p.currentKey),
                           vacToBefore: getVac(targetKey),
                           source: bumpedPilot
                               ? { type: 'pilot', sen: bumpedPilot.sen, name: bumpedPilot.name }
                               : { type: 'vacancy', label: 'retirement / system reduction' },
                           displacementBump: !!bumpedPilot,
                           bumpedSen: bumpedPilot ? bumpedPilot.sen : null,
                           forcedOut,
                           failedPrefs
                       };
                   } else {
                       const src = consumeSlot(targetKey);
                       log = {
                           step: 'A',
                           prefOrder: pr.order,
                           fromKey: p.currentKey,
                           toKey: targetKey,
                           vacFromBefore: getVac(p.currentKey),
                           vacToBefore: getVac(targetKey),
                           source: src,
                           displacementBump: false,
                           forcedOut,
                           failedPrefs
                       };
                   }
               } else {
                   if (p.orig === targetKey) {
                       log = { step: 'A', prefOrder: pr.order, fromKey: null, toKey: targetKey, stayed: true, forcedOut, failedPrefs };
                   } else {
                       log = p.moveLog;
                       if (log) log.failedPrefs = failedPrefs;
                   }
               }
               break;
           }
       }
  
       // ── STEP B: No pref awarded — try holding at orig base ──────────
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
               log = { step: 'B', fromKey: null, toKey: p.orig, stayed: true, forcedOut: false, failedPrefs };
           }
       }
  
       // ── STEP C: Force / Section-24 displacement fallback ────────────
       // If still not awarded, try system cascade options.
       // Force-displaced pilots: NO vacancy required (bump junior).
       // Everyone else: vacancy required (unchanged behavior).
       if (!awarded) {
           const cascadeOptions = [
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
                       const hasVac = getVac(targetKey) > 0;
                       let bumpedPilot = null;
  
                       if (forcedOut && !hasVac) {
                           bumpedPilot = mostJuniorAt(targetKey, p.sen);
                           if (bumpedPilot) {
                               bumpedPilot.isForceDisplaced = true;
                               bumpedPilot._lastBumperSen  = p.sen;
                               bumpedPilot._lastBumperName = p.name;
                               bumpedPilot._lastBumperFrom = p.currentKey;
                           }
                           log = {
                               step: 'C',
                               fromKey: p.currentKey,
                               toKey: targetKey,
                               vacFromBefore: getVac(p.currentKey),
                               vacToBefore: getVac(targetKey),
                               source: bumpedPilot
                                   ? { type: 'pilot', sen: bumpedPilot.sen, name: bumpedPilot.name }
                                   : { type: 'vacancy', label: 'retirement / system reduction' },
                               displacementBump: !!bumpedPilot,
                               bumpedSen: bumpedPilot ? bumpedPilot.sen : null,
                               forcedOut,
                               failedPrefs
                           };
                       } else {
                           const src = consumeSlot(targetKey);
                           log = {
                               step: 'C',
                               fromKey: p.currentKey,
                               toKey: targetKey,
                               vacFromBefore: getVac(p.currentKey),
                               vacToBefore: getVac(targetKey),
                               source: src,
                               displacementBump: false,
                               forcedOut,
                               failedPrefs
                           };
                       }
                   } else {
                       log = p.moveLog;
                   }
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
               origKey: p.orig,
               failedPrefs
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
               // For displacement bumps there is no new open slot created —
               // the displaced pilot leaving will register their own release
               // when they are processed. For normal moves, just increment.
               currentCounts[newSeat] = (currentCounts[newSeat] || 0) + 1;
           }
  
           const prevKey  = p.currentKey;
           p.currentKey   = newSeat;
           p.moved        = (newSeat !== p.orig);
           p.isUnassigned = (newSeat === "UNASSIGNED");
  
           auditTrail.push({ loop: loops, sen: p.sen, name: p.name, from: prevKey, to: newSeat, isPass: false, log });
  
           cascade = true;
           break;
       } else {
           p.moved        = (p.currentKey !== p.orig);
           p.isUnassigned = (p.currentKey === "UNASSIGNED");
  
           // Log every cascade pass for force-displaced pilots even when they
           // stay on the same key — captures hold → bump → re-hold chain.
           if (forcedOut) {
               const bumperSen  = p._lastBumperSen  || null;
               const bumperName = p._lastBumperName || null;
               const bumperFrom = p._lastBumperFrom || null;
               p._lastBumperSen  = null;
               p._lastBumperName = null;
               p._lastBumperFrom = null;
               auditTrail.push({
                   loop: loops,
                   sen: p.sen,
                   name: p.name,
                   from: p.currentKey,
                   to: p.currentKey,
                   isPass: true,
                   log: { step: 'PASS', currentKey: p.currentKey, bumperSen, bumperName, bumperFrom }
               });
           }
       }
   }
   if (loops > 10000) break;
  ```
  
  }
  
  // ── BUILD REASON STRING FROM A LOG OBJECT ────────────────────────────────
  function buildReasonFromLog(log, finalVacFn) {
  if (!log) return “No bid data.”;
  const finalVac = finalVacFn || ((key) => (targetMap[key] || 0) - (currentCounts[key] || 0));
  
  ```
   if (log.step === 'PASS') {
       if (log.bumperSen) {
           return `Bumped by Sen #${log.bumperSen} - ${log.bumperName} (${keyLabel(log.bumperFrom)} → ${keyLabel(log.currentKey)}). Re-holds ${keyLabel(log.currentKey)} at vacancy −1, awaiting next cascade pass.`;
       }
       return `Holds ${keyLabel(log.currentKey)} at vacancy −1, awaiting next cascade pass.`;
   }
   const bumpNote = (log.displacementBump && log.bumpedSen)
       ? ` Bumped Sen #${log.bumpedSen} (displacement chain).`
       : '';
   const sec24Prefix = log.forcedOut ? `Section 24 Displacement \u2014 ` : '';
  
   const failedStr = (log.failedPrefs && log.failedPrefs.length > 0)
       ? ' ' + log.failedPrefs.join(' ')
       : '';
  
   if (log.step === 'A' && !log.stayed) {
       const line1 = `${sec24Prefix}Awarded Pref #${log.prefOrder} \u2014 ${posLabel(log.toKey)}.${failedStr} ${fmtSource(log.source)}${bumpNote}`;
       const line2 = log.displacementBump
           ? `Displacement move \u2014 no vacancy consumed in ${keyLabel(log.toKey)}. Increase vacancy in ${keyLabel(log.fromKey)} from ${log.vacFromBefore} to ${log.vacFromBefore + 1}.`
           : `Reduce vacancy in ${keyLabel(log.toKey)} from ${log.vacToBefore} to ${log.vacToBefore - 1}. Increase vacancy in ${keyLabel(log.fromKey)} from ${log.vacFromBefore} to ${log.vacFromBefore + 1}.`;
       return line1 + '\n' + line2;
   } else if (log.step === 'A' && log.stayed) {
       const vac = finalVac(log.toKey);
       const cap = targetMap[log.toKey] || 0;
       return `${sec24Prefix}Awarded Pref #${log.prefOrder} \u2014 Remain in current position.${failedStr} ${keyLabel(log.toKey)} vacancy: ${vac} open of ${cap}.`;
   } else if (log.step === 'B') {
       return `Remain in current position.`;
   } else if (log.step === 'C') {
       const line1 = `Section 24 Displacement \u2014 ${posLabel(log.toKey)}.${failedStr} ${fmtSource(log.source)}${bumpNote}`;
       const line2 = log.displacementBump
           ? `Displacement move \u2014 no vacancy consumed in ${keyLabel(log.toKey)}. Increase vacancy in ${keyLabel(log.fromKey)} from ${log.vacFromBefore} to ${log.vacFromBefore + 1}.`
           : `Reduce vacancy in ${keyLabel(log.toKey)} from ${log.vacToBefore} to ${log.vacToBefore - 1}. Increase vacancy in ${keyLabel(log.fromKey)} from ${log.vacFromBefore} to ${log.vacFromBefore + 1}.`;
       return line1 + '\n' + line2;
   } else if (log.step === 'D') {
       if (log.selfDisp) {
           return `BPL Failure \u2014 Rank ${log.bplRank} exceeds limit of ${log.bplLimit} for ${posLabel(log.origKey)}. Increase vacancy in ${keyLabel(log.fromKey)} from ${log.vacFromBefore} to ${log.vacFromBefore + 1}.`;
       } else {
           return `Displaced: No position available \u2014 system-wide reduction. Increase vacancy in ${keyLabel(log.fromKey)} from ${log.vacFromBefore} to ${log.vacFromBefore + 1}.`;
       }
   }
   return "No bid data.";
  ```
  
  }
  
  // ── STAMP REASON ON EACH AUDIT TRAIL ENTRY ───────────────────────────────
  auditTrail.forEach(entry => {
  entry.reason = buildReasonFromLog(entry.log);
  });
  
  // ── BUILD FINAL AWARDED REASON STRINGS ───────────────────────────────────
  bidders.forEach(p => {
  const log = p.moveLog;
  if (!log) { p.awardedReason = “No bid data.”; return; }
  const finalVac = (key) => (targetMap[key] || 0) - (currentCounts[key] || 0);
  p.awardedReason = buildReasonFromLog(log, finalVac);
  });
  
  return { roster: bidders, loops, auditTrail, targetMap };
  }
