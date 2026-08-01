function runBidEngine(data, deltaMap) {
  // ── UTILITIES ─────────────────────────────────────────────────────────────
  const is737 = p => p.current && p.current.equip === "737";
  const keyOf = p => p.current ? `${p.current.base}-${p.current.seat}` : "UNASSIGNED";
  const makeKey = (base, seat) => `${base}-${seat}`;

  // ── SETUP: FILTER ROSTER ──────────────────────────────────────────────────
  const retiredSens = new Set((data.retired || []).map(p => p.sen || p.seniority));
  const noBidSens  = new Set((data.noBid  || []).map(p => p.sen || p.seniority));

  // Active bidders only (snapshot is for active line pilots)
  const activeBidders = data.roster.filter(p =>
    is737(p) && !retiredSens.has(p.sen) && !noBidSens.has(p.sen)
  );

  // ── BUILD FULL PILOT ARRAY (for rank calculations) ─────────────────────────
  // Include NO BID pilots so rank counts are accurate, but mark them
  const noBidPilots = data.roster.filter(p =>
    is737(p) && !retiredSens.has(p.sen) && noBidSens.has(p.sen)
  );

  const allPilots = [];

  function buildPilotObj(p, type) {
    const orig = keyOf(p);
    const prefs = (data.preferences || []).filter(pr => pr.sen === p.sen)
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

  // Sort by seniority (lowest number = most senior)
  allPilots.sort((a, b) => a.sen - b.sen);

  // ── CAPACITY / TARGET SETUP ────────────────────────────────────────────────
  const targetMap = {};  // key -> target cap
  const currentCounts = {}; // key -> current count
  const slotSources = {};  // key -> array of {sen, name} for traceability

  // Initialize from live headcount
  allPilots.forEach(p => {
    if (p.currentKey !== "UNASSIGNED") {
      currentCounts[p.currentKey] = (currentCounts[p.currentKey] || 0) + 1;
    }
  });

  // Apply deltas to get targets
  const bases = ['ANC','SEA','LAX','SAN','SFO','PDX'];
  const seats = ['CA','FO'];
  bases.forEach(base => {
    seats.forEach(seat => {
      const key = makeKey(base, seat);
      const delta = (deltaMap && deltaMap[key]) || 0;
      targetMap[key] = (currentCounts[key] || 0) + delta;
      if (targetMap[key] < 0) targetMap[key] = 0;
    });
  });

  // Initialize vacancies: target - current (negative = over capacity)
  const vacancies = {};
  Object.keys(targetMap).forEach(key => {
    vacancies[key] = targetMap[key] - (currentCounts[key] || 0);
  });

  // ── SLOT TRACKING ───────────────────────────────────────────────────────────
  function getVac(key) { return vacancies[key] || 0; }

  function consumeSlot(key) {
    if (vacancies[key] > 0) {
      vacancies[key]--;
      return true;
    }
    return false;
  }

  function releaseSlot(key, sen, name) {
    if (!key || key === "UNASSIGNED") return;
    vacancies[key] = (vacancies[key] || 0) + 1;
    if (!slotSources[key]) slotSources[key] = [];
    slotSources[key].push({ sen, name, type: 'release' });
  }

  // ── RANK & JUNIOR HELPERS ─────────────────────────────────────────────────
  function computeRank(pilot, targetKey) {
    // Rank = 1 + count of pilots senior to this pilot who are at targetKey
    let rank = 1;
    for (const other of allPilots) {
      if (other.sen >= pilot.sen) break;
      if (other.currentKey === targetKey) rank++;
    }
    return rank;
  }

  function mostJuniorAt(key, minSen) {
    // Find the most junior pilot at key with sen > minSen
    let junior = null;
    for (const p of allPilots) {
      if (p.currentKey === key && p.sen > minSen) {
        if (!junior || p.sen > junior.sen) junior = p;
      }
    }
    return junior;
  }

  // ── PHASE 1: VACANCY FILL ─────────────────────────────────────────────────
  // Process ALL pilots in seniority order.
  // Only actual vacancies are consumed. No bumping. No displacement.
  // If no vacancy available for a preference, skip to next preference.
  // If no preference works, pilot holds current position.

  for (const p of allPilots) {
    if (p.bidderType === 'nobid') {
      // NO BID pilots never move; they just hold current
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

      // Compute rank at target
      const rank = computeRank(p, targetKey);

      // Check BPL and cap
      if (rank > pr.bpl || rank > cap) {
        p.log.push(`Pref ${pr.order}: ${targetKey} denied (rank ${rank} > bpl ${pr.bpl} or cap ${cap})`);
        continue;
      }

      // PHASE 1: MUST have actual vacancy to move in
      if (isMovingIn && getVac(targetKey) <= 0) {
        p.log.push(`Pref ${pr.order}: ${targetKey} denied (0 vacancy)`);
        continue;
      }

      // AWARD
      if (isMovingIn) {
        consumeSlot(targetKey);
      }

      // Release old slot (creates new vacancy for later pilots)
      if (p.orig !== "UNASSIGNED" && p.orig !== targetKey) {
        releaseSlot(p.orig, p.sen, p.name);
        currentCounts[p.orig] = (currentCounts[p.orig] || 0) - 1;
      }

      if (targetKey !== "UNASSIGNED") {
        currentCounts[targetKey] = (currentCounts[targetKey] || 0) + 1;
      }

      p.currentKey = targetKey;
      p.awardedPrefNum = pr.order;
      p.awardedReason = isMovingIn ? 'VACANCY' : 'HOLD';
      awarded = true;
      p.log.push(`Pref ${pr.order}: ${targetKey} AWARDED (rank ${rank}, vac ${getVac(targetKey)})`);
      break;
    }

    if (!awarded) {
      // Hold current position
      p.awardedPrefNum = p.prefs.length > 0 ? 'HOLD' : 'NO_PREF';
      p.awardedReason = 'HOLD';
      p.log.push(`Holding current position ${p.currentKey}`);
    }
  }

  // ── PHASE 2: IDENTIFY FORCE-DISPLACED ─────────────────────────────────────
  // After all bids, any base-seat over its cap displaces the most junior pilots

  const displaced = [];

  for (const key of Object.keys(targetMap)) {
    const cap = targetMap[key];
    const atKey = allPilots.filter(p => p.currentKey === key)
                           .sort((a, b) => a.sen - b.sen);
    const over = atKey.length - cap;

    if (over > 0) {
      // The 'over' most junior are force-displaced
      const displacedHere = atKey.slice(-over);
      displacedHere.forEach(p => {
        p.isForceDisplaced = true;
        p.awardedReason = 'DISPLACED';
        p.log.push(`Force displaced from ${key} (cap ${cap}, count ${atKey.length})`);
        displaced.push(p);
      });
    }
  }

  // ── PHASE 3: DISPLACEMENT CASCADE ───────────────────────────────────────────
  // Displaced pilots bid with bump rights. Repeat until stable.

  let cascade = true;
  let loopCount = 0;
  const maxLoops = 100;

  while (cascade && displaced.length > 0 && loopCount < maxLoops) {
    cascade = false;
    loopCount++;

    // Sort displaced by seniority (most senior first)
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

        // Displacement: vacancy OR bump
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
          // Try to bump the most junior pilot at target
          const junior = mostJuniorAt(targetKey, p.sen);
          if (junior && !bumpedThisRound.has(junior.sen)) {
            // Bump the junior pilot
            junior.isForceDisplaced = true;
            bumpedThisRound.add(junior.sen);
            stillDisplaced.push(junior);
            junior.log.push(`Bumped from ${targetKey} by Sen ${p.sen} ${p.name}`);

            // Move displaced pilot to target
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

      // ── Try displacement fallback order (24.E.6.b) ──
      if (!awarded) {
        const parts = p.currentKey.split('-');
        const origBase = parts[0] || '';
        const origSeat = parts[1] || '';

        const cascadeOptions = [
          p.currentKey,  // same base, same seat
          ...bases.filter(b => b !== origBase).map(b => makeKey(b, origSeat)),
          makeKey(origBase, 'FO'),  // same base, FO
          ...bases.filter(b => b !== origBase).map(b => makeKey(b, 'FO'))
        ];

        for (const targetKey of cascadeOptions) {
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
        // Still displaced - will try again next loop
        p.currentKey = "UNASSIGNED";
        stillDisplaced.push(p);
        p.log.push(`Still displaced - UNASSIGNED (loop ${loopCount})`);
      } else {
        cascade = true; // Someone moved, may create new displacements
      }
    }

    // Replace displaced array with those still displaced
    displaced.length = 0;
    displaced.push(...stillDisplaced);
  }

  // ── RETURN RESULTS ─────────────────────────────────────────────────────────
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
    currentCounts,
    slotSources
  };
}

// Export for Node / browser compatibility
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { runBidEngine };
}
