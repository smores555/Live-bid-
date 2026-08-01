function runBidEngine(data, deltaMap) {
  // ── HELPERS ────────────────────────────────────────────────────────────────
  const is737 = p => p.current && p.current.equip === "737";
  const keyOf = p => p.current ? `${p.current.base}-${p.current.seat}` : "UNASSIGNED";
  const makeKey = (base, seat) => `${base}-${seat}`;

  // ── PARSE INPUT DATA ───────────────────────────────────────────────────────
  const retiredSens = new Set((data.retired || []).map(p => p.sen || p.seniority));
  const noBidSens   = new Set((data.noBid  || []).map(p => p.sen || p.seniority));

  const activeBidders = data.roster.filter(p =>
    is737(p) && !retiredSens.has(p.sen) && !noBidSens.has(p.sen)
  );

  const noBidPilots = data.roster.filter(p =>
    is737(p) && !retiredSens.has(p.sen) && noBidSens.has(p.sen)
  );

  // ── BUILD MASTER PILOT ARRAY ─────────────────────────────────────────────────
  const allPilots = [];

  function buildPilotObj(p, type) {
    const orig = keyOf(p);
    const prefs = (data.preferences || [])
      .filter(pr => pr.sen === p.sen)
      .sort((a, b) => (a.order || a.prefOrder || 0) - (b.order || b.prefOrder || 0));

    return {
      sen: p.sen,
      name: p.name,
      orig: orig,
      currentKey: orig,
      prefs: prefs.map(pr => ({
        targetKey: pr.targetKey || makeKey(pr.base, pr.seat),
        bpl: (pr.bpl_min || pr.bpl || 0) === 0 ? 99999 : parseInt(pr.bpl_min || pr.bpl),
        order: pr.order || pr.prefOrder || 0
      })),
      bidderType: type,
      isForceDisplaced: false,
      awardedPrefNum: null,
      awardedReason: null,
      log: []
    };
  }

  activeBidders.forEach(p => allPilots.push(buildPilotObj(p, 'active')));
  noBidPilots.forEach(p => allPilots.push(buildPilotObj(p, 'nobid')));

  allPilots.sort((a, b) => a.sen - b.sen);

  // ── CAPACITY / VACANCY SETUP ───────────────────────────────────────────────
  const bases = ['ANC','SEA','LAX','SAN','SFO','PDX'];
  const seats = ['CA','FO'];

  const targetMap = {};
  const currentCounts = {};

  allPilots.forEach(p => {
    if (p.currentKey !== "UNASSIGNED") {
      currentCounts[p.currentKey] = (currentCounts[p.currentKey] || 0) + 1;
    }
  });

  bases.forEach(base => {
    seats.forEach(seat => {
      const key = makeKey(base, seat);
      const delta = (deltaMap && deltaMap[key]) || 0;
      targetMap[key] = Math.max(0, (currentCounts[key] || 0) + delta);
    });
  });

  const vacancies = {};
  Object.keys(targetMap).forEach(key => {
    vacancies[key] = targetMap[key] - (currentCounts[key] || 0);
  });

  // ── SLOT TRACKING ──────────────────────────────────────────────────────────
  function getVac(key) { return vacancies[key] || 0; }

  function consumeSlot(key) {
    if (vacancies[key] > 0) {
      vacancies[key]--;
      return true;
    }
    return false;
  }

  function releaseSlot(key) {
    if (!key || key === "UNASSIGNED") return;
    vacancies[key] = (vacancies[key] || 0) + 1;
  }

  // ── RANK & JUNIOR HELPERS ──────────────────────────────────────────────────
  function computeRank(pilot, targetKey) {
    let rank = 1;
    for (const other of allPilots) {
      if (other.sen >= pilot.sen) break;
      if (other.currentKey === targetKey) rank++;
    }
    return rank;
  }

  function mostJuniorAt(key, minSen) {
    let junior = null;
    for (const p of allPilots) {
      if (p.currentKey === key && p.sen > minSen) {
        if (!junior || p.sen > junior.sen) junior = p;
      }
    }
    return junior;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 1: VACANCY FILL
  // Process all active bidders in seniority order.
  // ONLY actual vacancies are consumed. No bumping. No displacement.
  // ═══════════════════════════════════════════════════════════════════════════
  for (const p of allPilots) {
    if (p.bidderType === 'nobid') {
      p.awardedPrefNum = 'NO_BID';
      p.awardedReason = 'NO_BID';
      continue;
    }

    let awarded = false;

    for (const pr of p.prefs) {
      if (!pr.targetKey) continue;
      const targetKey = pr.targetKey;
      const cap = targetMap[targetKey] || 0;
      const isMovingIn = (p.orig !== targetKey);

      const rank = computeRank(p, targetKey);

      if (rank > pr.bpl || rank > cap) {
        p.log.push(`Pref ${pr.order}: ${targetKey} denied (rank ${rank} > bpl ${pr.bpl} or cap ${cap})`);
        continue;
      }

      if (isMovingIn && getVac(targetKey) <= 0) {
        p.log.push(`Pref ${pr.order}: ${targetKey} denied (0 vacancy)`);
        continue;
      }

      // AWARD
      if (isMovingIn) consumeSlot(targetKey);

      if (p.orig !== "UNASSIGNED" && p.orig !== targetKey) {
        releaseSlot(p.orig);
        currentCounts[p.orig] = (currentCounts[p.orig] || 0) - 1;
      }

      if (targetKey !== "UNASSIGNED") {
        currentCounts[targetKey] = (currentCounts[targetKey] || 0) + 1;
      }

      p.currentKey = targetKey;
      p.awardedPrefNum = pr.order;
      p.awardedReason = isMovingIn ? 'VACANCY' : 'HOLD';
      awarded = true;
      p.log.push(`Pref ${pr.order}: ${targetKey} AWARDED (rank ${rank})`);
      break;
    }

    if (!awarded) {
      p.awardedPrefNum = p.prefs.length > 0 ? 'HOLD' : 'NO_PREF';
      p.awardedReason = 'HOLD';
      p.log.push(`Holding current position ${p.currentKey}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 2: IDENTIFY FORCE-DISPLACED
  // After all bids, any base-seat over its cap displaces the most junior.
  // ═══════════════════════════════════════════════════════════════════════════
  const displaced = [];

  for (const key of Object.keys(targetMap)) {
    const cap = targetMap[key];
    const atKey = allPilots
      .filter(p => p.currentKey === key)
      .sort((a, b) => a.sen - b.sen);

    const over = atKey.length - cap;
    if (over > 0) {
      atKey.slice(-over).forEach(p => {
        p.isForceDisplaced = true;
        p.awardedReason = 'DISPLACED';
        p.log.push(`Force displaced from ${key} (cap ${cap}, count ${atKey.length})`);
        displaced.push(p);
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 3: DISPLACEMENT CASCADE
  // Displaced pilots bid with bump rights. Repeat until stable.
  // ═══════════════════════════════════════════════════════════════════════════
  let cascade = true;
  let loopCount = 0;
  const maxLoops = 100;

  while (cascade && displaced.length > 0 && loopCount < maxLoops) {
    cascade = false;
    loopCount++;

    displaced.sort((a, b) => a.sen - b.sen);

    const stillDisplaced = [];
    const bumpedThisRound = new Set();

    for (const p of displaced) {
      let awarded = false;

      // ── Try preferences first ──
      for (const pr of p.prefs) {
        if (!pr.targetKey) continue;
        const targetKey = pr.targetKey;
        const cap = targetMap[targetKey] || 0;

        const rank = computeRank(p, targetKey);
        if (rank > pr.bpl || rank > cap) continue;

        if (getVac(targetKey) > 0) {
          consumeSlot(targetKey);
          if (p.currentKey !== "UNASSIGNED") {
            currentCounts[p.currentKey] = (currentCounts[p.currentKey] || 0) - 1;
          }
          currentCounts[targetKey] = (currentCounts[targetKey] || 0) + 1;
          p.currentKey = targetKey;
          p.awardedPrefNum = pr.order;
          p.awardedReason = 'DISPLACED_PREF';
          p.log.push(`Displacement Pref ${pr.order}: ${targetKey} AWARDED (vacancy)`);
          awarded = true;
          break;
        } else {
          const junior = mostJuniorAt(targetKey, p.sen);
          if (junior && !bumpedThisRound.has(junior.sen)) {
            junior.isForceDisplaced = true;
            bumpedThisRound.add(junior.sen);
            stillDisplaced.push(junior);
            junior.log.push(`Bumped from ${targetKey} by Sen ${p.sen} ${p.name}`);

            if (p.currentKey !== "UNASSIGNED") {
              currentCounts[p.currentKey] = (currentCounts[p.currentKey] || 0) - 1;
            }
            currentCounts[targetKey] = (currentCounts[targetKey] || 0) + 1;
            p.currentKey = targetKey;
            p.awardedPrefNum = pr.order;
            p.awardedReason = 'DISPLACED_PREF';
            p.log.push(`Displacement Pref ${pr.order}: ${targetKey} AWARDED (bumped Sen ${junior.sen})`);
            awarded = true;
            break;
          }
        }
      }

      // ── Fallback order (24.E.6.b) ──
      if (!awarded) {
        const parts = p.currentKey.split('-');
        const origBase = parts[0] || '';
        const origSeat = parts[1] || '';

        const fallbackOptions = [
          p.currentKey,
          ...bases.filter(b => b !== origBase).map(b => makeKey(b, origSeat)),
          makeKey(origBase, 'FO'),
          ...bases.filter(b => b !== origBase).map(b => makeKey(b, 'FO'))
        ];

        for (const targetKey of fallbackOptions) {
          if (targetMap[targetKey] === undefined) continue;
          const cap = targetMap[targetKey] || 0;

          const rank = computeRank(p, targetKey);
          if (rank > cap) continue;

          if (getVac(targetKey) > 0) {
            consumeSlot(targetKey);
            if (p.currentKey !== "UNASSIGNED") {
              currentCounts[p.currentKey] = (currentCounts[p.currentKey] || 0) - 1;
            }
            currentCounts[targetKey] = (currentCounts[targetKey] || 0) + 1;
            p.currentKey = targetKey;
            p.awardedPrefNum = '24.E.6.b';
            p.awardedReason = 'DISPLACED_FALLBACK';
            p.log.push(`Displacement fallback: ${targetKey} AWARDED (vacancy)`);
            awarded = true;
            break;
          } else {
            const junior = mostJuniorAt(targetKey, p.sen);
            if (junior && !bumpedThisRound.has(junior.sen)) {
              junior.isForceDisplaced = true;
              bumpedThisRound.add(junior.sen);
              stillDisplaced.push(junior);
              junior.log.push(`Bumped from ${targetKey} by Sen ${p.sen} ${p.name} (fallback)`);

              if (p.currentKey !== "UNASSIGNED") {
                currentCounts[p.currentKey] = (currentCounts[p.currentKey] || 0) - 1;
              }
              currentCounts[targetKey] = (currentCounts[targetKey] || 0) + 1;
              p.currentKey = targetKey;
              p.awardedPrefNum = '24.E.6.b';
              p.awardedReason = 'DISPLACED_FALLBACK';
              p.log.push(`Displacement fallback: ${targetKey} AWARDED (bumped Sen ${junior.sen})`);
              awarded = true;
              break;
            }
          }
        }
      }

      if (!awarded) {
        p.currentKey = "UNASSIGNED";
        stillDisplaced.push(p);
        p.log.push(`Still displaced - UNASSIGNED (loop ${loopCount})`);
      } else {
        cascade = true;
      }
    }

    displaced.length = 0;
    displaced.push(...stillDisplaced);
  }

  // ── RETURN ─────────────────────────────────────────────────────────────────
  return {
    roster: allPilots.map(p => ({
      sen: p.sen,
      name: p.name,
      orig: p.orig,
      currentKey: p.currentKey,
      awardedPrefNum: p.awardedPrefNum,
      isForceDisplaced: p.isForceDisplaced,
      awardedReason: p.awardedReason,
      log: p.log
    })),
    vacancies,
    targetMap,
    currentCounts
  };
}
