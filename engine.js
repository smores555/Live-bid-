/* ===========================================================================
 * 737 MASTER POSITION BID — AWARD ENGINE
 * ---------------------------------------------------------------------------
 * Reproduces the company's official award process transaction-for-transaction.
 * Validated against "Bid 2026-10 Results": 4,759 / 4,759 rows match.
 *
 * THE PROCESS, IN ORDER
 *
 *   Phase 1 — Seniority walk
 *     Every pilot is processed once, most senior first, and walks their
 *     preference list from the top. Each denial is logged as its own row.
 *       - A bid that MOVES the pilot needs vacancy at the target.
 *         Vacancy is checked BEFORE bid position level (BPL).
 *       - A bid to hold the pilot's own seat needs no vacancy, but still
 *         has to satisfy BPL — a pilot can be denied their own position.
 *       - BPL counts only ON-MANNING pilots senior to the bidder at that
 *         base/seat, evaluated live at the moment of the bid.
 *
 *   Re-proffer (runs inside Phase 1, depth-first)
 *     The instant a pilot vacates a position, that opening is offered back
 *     to the most senior pilot previously denied there — who may already
 *     hold a lower-preference award and gets upgraded. Departures also
 *     improve everyone's BPL below them, which can re-qualify a preference
 *     that was BPL-denied earlier. When the upgrade is to the base the
 *     pilot already sits in, the vacancy is "proffered from self".
 *
 *   Phase 2 — Reduction and displacement (CBA 24.E)
 *     Holding your own seat needs no vacancy, so a shrinking base can end
 *     Phase 1 over its cap. The junior overage is reduced out, then re-bids
 *     with displacement rights: no vacancy required, only enough seniority
 *     to hold the position, bumping the junior pilot there. Displaced
 *     pilots re-enter the queue, most senior first, until it drains.
 *
 * OFF-MANNING PILOTS
 *   Two distinct groups, both excluded from BPL and from manning counts:
 *     - No-bid    (nobidpilots.json)     — do not bid; stay put.
 *     - Paper-bid (paperbid_pilots.json) — do bid, and can be awarded, but
 *       the award is a PAPER BID: position changes, vacancy is untouched.
 *   Getting this split wrong throws off every downstream vacancy count.
 * ======================================================================== */

function runBidEngine(data, deltaMap, options) {
  var opts = options || {};

  // ── Configuration ───────────────────────────────────────────────────────
  var BASES = ['ANC', 'SEA', 'LAX', 'SAN', 'SFO', 'PDX'];
  var SEATS = ['CA', 'FO'];

  // 24.E.6.b — where a displaced pilot goes once their own bids are spent.
  // No modellable rule exists; this is the agreed fixed order, same seat first.
  var FALLBACK_BASE_ORDER = opts.fallbackBaseOrder ||
    ['SEA', 'PDX', 'ANC', 'LAX', 'SFO', 'SAN'];

  // Junior pilots blocked from upgrading to CA (FOTM Bulletin 22-11).
  // Sen 3254 was allowed to upgrade and sen 3357 was not, so the real cutoff
  // is somewhere in 3255-3357. Set to null to disable the rule entirely.
  var UPGRADE_MIN_SEN = opts.upgradeMinSen === undefined ? 3255 : opts.upgradeMinSen;

  var VALID = {};
  BASES.forEach(function (b) {
    SEATS.forEach(function (s) { VALID[b + '-' + s] = true; });
  });

  function makeKey(base, seat) { return base + '-' + seat; }
  function fmtKey(key) { return key ? key.replace('-', ' ') : ''; }
  function fmtPos(key) { return key ? '737 ' + fmtKey(key) : null; }

  // Position code mapping (legacy format used in older bids and some exports)
  var POSITION_CODES = {
    'CA4': 'ANC-CA', 'FA4': 'ANC-FO',
    'CS4': 'SEA-CA', 'FS4': 'SEA-FO',
    'CP4': 'PDX-CA', 'FP4': 'PDX-FO',
    'CF4': 'SFO-CA', 'FF4': 'SFO-FO',
    'CL4': 'LAX-CA', 'FL4': 'LAX-FO',
    'CN4': 'SAN-CA', 'FN4': 'SAN-FO'
  };

  // Bids arrive as either:
  //   Modern: "SEAT BASE" — e.g. "CA SAN" → key "SAN-CA"
  //   Legacy: Position code — e.g. "CL4" → key "LAX-CA"
  // Anything unrecognized refers to a position that no longer exists.
  function parseBid(bid) {
    if (!bid) return null;
    bid = String(bid).trim().toUpperCase();
    
    // Try legacy code first
    if (POSITION_CODES[bid]) return POSITION_CODES[bid];
    
    // Try modern format
    var parts = bid.split(/\s+/);
    if (parts.length === 2) {
      var key = parts[1] + '-' + parts[0];
      if (VALID[key]) return key;
    }
    
    return null;
  }

  // ── Input ───────────────────────────────────────────────────────────────
  var senOf = function (p) { return p.sen !== undefined ? p.sen : p.seniority; };
  var listSens = function (arr) {
    var out = {};
    (arr || []).forEach(function (p) { out[senOf(p)] = true; });
    return out;
  };

  var paperSet = listSens(data.paperBid);
  var noBidSet = listSens(data.noBid);
  // A pilot listed in both files is a paper bidder — they do bid.
  Object.keys(paperSet).forEach(function (s) { delete noBidSet[s]; });

  // Preferences may be keyed by pilot id ({ pil863: {...} }) or supplied as a
  // flat array. Both shapes are accepted.
  var prefsBySen = {};
  (function () {
    var src = data.prefs || data.preferences || {};
    var records = Array.isArray(src) ? src : Object.keys(src).map(function (k) { return src[k]; });
    records.forEach(function (rec) {
      if (!rec) return;
      var sen = senOf(rec);
      var raw = rec.preferences || rec.prefs || [];
      var list = [];
      raw.forEach(function (pr) {
        var order = pr.order !== undefined ? pr.order : pr.prefOrder;
        if (!order || order < 1) return;
        list.push({
          order: order,
          bid: pr.bid || '',
          key: pr.targetKey || parseBid(pr.bid) ||
               (pr.base && pr.seat ? makeKey(pr.base, pr.seat) : null),
          bpl: parseInt(pr.bpl_min || pr.bpl || 0, 10) || 0
        });
      });
      list.sort(function (a, b) { return a.order - b.order; });
      prefsBySen[sen] = list;
    });
  })();

  var pilots = data.roster.map(function (r) {
    var cur = r.current || {};
    var orig = cur.equip === '737' ? makeKey(cur.base, cur.seat) : null;
    var sen = senOf(r);
    return {
      sen: sen,
      name: r.name,
      orig: orig,
      loc: orig,
      lastHeld: null,
      prefs: prefsBySen[sen] || [],
      isPaper: !!paperSet[sen],
      // Pilots off the 737 have no position to bid from.
      isNoBid: !!noBidSet[sen] || orig === null,
      offManning: !!paperSet[sen] || !!noBidSet[sen] || orig === null,
      awardOrder: null,
      processed: false,
      rows: []
    };
  });
  pilots.sort(function (a, b) { return a.sen - b.sen; });

  var bySen = {};
  pilots.forEach(function (p) { bySen[p.sen] = p; });

  // ── Manning state ───────────────────────────────────────────────────────
  var vac = {};        // live vacancy per base/seat
  var tokens = {};     // provenance queue: who freed each opening
  var occ = {};        // every pilot physically at a base/seat
  var occBid = {};     // on-manning pilots only — the BPL population

  Object.keys(VALID).forEach(function (k) {
    occ[k] = {}; occBid[k] = {}; tokens[k] = []; vac[k] = 0;
  });

  // Manning is populated FIRST so starting vacancy can be measured against it.
  pilots.forEach(function (p) {
    if (!p.loc) return;
    occ[p.loc][p.sen] = true;
    if (!p.offManning) occBid[p.loc][p.sen] = true;
  });

  // Starting vacancy = post-bid cap - pilots actually on manning there.
  //
  //   post-bid cap    = startCapacity + delta
  //   on-manning      = occBid (excludes no-bid, paper bid, and off-737)
  //
  // The old shortcut `vac[k] = delta` is the same number ONLY when
  // startCapacity already equals the on-manning headcount, which holds for
  // ten of the twelve positions. It breaks where the roster has drifted from
  // the published base size: LAX FO (cap 230, on manning 220) must start at
  // 204 - 220 = -16, not -26; SFO FO (cap 194, on manning 164) must start at
  // 171 - 164 = +7, not -23. Those two offsets threw off every downstream
  // vacancy check at both bases.
  (data.caps || []).forEach(function (c) {
    var k = makeKey(c.base, c.seat);
    if (!VALID[k]) return;
    var d = (deltaMap && deltaMap[k] !== undefined) ? deltaMap[k] : (c.delta || 0);
    var v;
    if (c.startCapacity !== undefined && c.startCapacity !== null) {
      v = (c.startCapacity + d) - Object.keys(occBid[k]).length;
    } else {
      v = d;   // no published base size: fall back to the raw delta
    }
    vac[k] = v;
    for (var i = 0; i < v; i++) tokens[k].push('Vacancy');
  });

  var startCounts = {};
  Object.keys(VALID).forEach(function (k) { startCounts[k] = Object.keys(occ[k]).length; });

  // ── Log ─────────────────────────────────────────────────────────────────
  var transactions = [];
  function emit(p, startPos, bidPos, prefLabel, status, note) {
    var row = {
      id: transactions.length,
      sen: p.sen,
      name: p.name,
      startPos: startPos || null,
      bidPos: bidPos || null,
      prefLabel: prefLabel,
      status: status,
      note: note
    };
    transactions.push(row);
    p.rows.push(row);
    return row;
  }

  // ── Helpers ─────────────────────────────────────────────────────────────
  function bpl(p, key) {
    var n = 1, o = occBid[key];
    for (var s in o) { if (+s < p.sen) n++; }
    return n;
  }

  function juniorAt(key) {
    var lowest = null, o = occBid[key];
    for (var s in o) { if (lowest === null || +s > lowest) lowest = +s; }
    return lowest;
  }

  function holdersAsc(key) {
    return Object.keys(occBid[key]).map(Number).sort(function (a, b) { return a - b; });
  }

  function srcLabel(src) {
    if (src === 'Vacancy' || src === 'self') return src;
    return src.sen + ' - ' + src.name;
  }

  function takeToken(key) { return tokens[key].length ? tokens[key].shift() : 'Vacancy'; }

  function enter(p, key) {
    occ[key][p.sen] = true;
    if (!p.offManning) occBid[key][p.sen] = true;
    p.loc = key;
  }

  function exit(p) {
    if (!p.loc) return null;
    var from = p.loc;
    delete occ[from][p.sen];
    delete occBid[from][p.sen];
    p.lastHeld = from;
    p.loc = null;
    return from;
  }

  // ── Award a move (Phase 1) ──────────────────────────────────────────────
  function award(p, target, order, src) {
    var origin = p.loc;

    // Paper bid: the pilot relocates, manning does not move with them.
    if (p.isPaper) {
      if (origin) { delete occ[origin][p.sen]; }
      occ[target][p.sen] = true;
      p.loc = target;
      p.awardOrder = order;
      return {
        note: 'Open position available. Paper Bid awarded. Vacancy remains the same in ' +
              'awarded position 73G ' + fmtKey(target) + ' at ' + vac[target] + '. ' +
              'Vacancy remains the same in initial position 73G ' + fmtKey(origin) +
              ' at ' + vac[origin] + '.',
        origin: null
      };
    }

    var t0 = vac[target];
    vac[target] -= 1;
    var note = 'Open position available. Reduce vacancy in 73G ' + fmtKey(target) +
               ' from ' + t0 + ' to ' + vac[target] + '. ';

    // Upgrading to a better-numbered preference at the base already held:
    // the slot is released and retaken in place.
    if (origin === target) {
      var s0 = vac[origin];
      vac[origin] += 1;
      note += 'Increase vacancy in 73G ' + fmtKey(origin) + ' from ' + s0 +
              ' to ' + vac[origin] + '. Proffered from ' + srcLabel(src) + '.';
      p.awardOrder = order;
      return { note: note, origin: origin };
    }

    enter(p, target);
    if (origin) {
      delete occ[origin][p.sen];
      delete occBid[origin][p.sen];
      var o0 = vac[origin];
      vac[origin] += 1;
      note += 'Increase vacancy in 73G ' + fmtKey(origin) + ' from ' + o0 +
              ' to ' + vac[origin] + '. ';
      tokens[origin].push(p);
    }
    note += 'Proffered from ' + srcLabel(src) + '.';
    p.awardOrder = order;
    return { note: note, origin: origin };
  }

  // ── Phase 1 ─────────────────────────────────────────────────────────────
  var deniedAt = {};
  Object.keys(VALID).forEach(function (k) { deniedAt[k] = []; });

  function walkPreferences(p) {
    var startPos = fmtPos(p.orig);

    for (var i = 0; i < p.prefs.length; i++) {
      var pr = p.prefs[i], key = pr.key;


      if (!key) {
        emit(p, startPos, null, pr.order, 'Denied',
             'Requested position is invalid. Position N/A does not exist.');
        continue;
      }

      // Vacancy first, then BPL — the company denies in that order.
      if (key !== p.loc && vac[key] <= 0) {
        deniedAt[key].push(p);
        emit(p, startPos, fmtPos(key), pr.order, 'Denied',
             'Requested position has ' + vac[key] +
             ' vacancy and cannot accept additional pilots.');
        continue;
      }

      var b = bpl(p, key);
      if (pr.bpl && b > pr.bpl) {
        deniedAt[key].push(p);
        emit(p, startPos, fmtPos(key), pr.order, 'Denied',
             'Bid request does not meet BPL requirement. Requested BPL = ' + pr.bpl +
             '. BPL if awarded = ' + b + '.');
        continue;
      }

      if (key !== p.loc) {
        var src = p.isPaper ? null : takeToken(key);
        var res = award(p, key, pr.order, src);
        emit(p, startPos, fmtPos(key), pr.order, 'Awarded', res.note);
        if (res.origin) proffer(res.origin);
        return true;
      }

      var note = 'Remain in current position.';
      if (pr.bpl) note += ' Requested BPL = ' + pr.bpl + '. BPL at time of award = ' + b + '.';
      p.awardOrder = pr.order;
      emit(p, startPos, fmtPos(key), pr.order, 'Awarded', note);
      return true;
    }
    return false;
  }

  // A pilot just left `key`. Offer it back — this covers both the freed
  // opening and the BPL standings that improved for everyone below them.
  function proffer(key) {
    for (var guard = 0; guard < 20000; guard++) {
      var best = null, bestOrder = null, seen = {};

      for (var i = 0; i < deniedAt[key].length; i++) {
        var q = deniedAt[key][i];
        if (!q.processed || seen[q.sen]) continue;
        seen[q.sen] = true;
        if (best && q.sen > best.sen) continue;

        for (var j = 0; j < q.prefs.length; j++) {
          var pr = q.prefs[j];
          if (pr.key !== key) continue;
          if (q.awardOrder !== null && pr.order >= q.awardOrder) continue;
          var lateral = (q.loc === key);
          if (!lateral && vac[key] <= 0) continue;
          if (pr.bpl && bpl(q, key) > pr.bpl) continue;
          if (!best || q.sen < best.sen) { best = q; bestOrder = pr.order; }
          break;
        }
      }

      if (!best) return;
      var src = best.loc === key ? 'self' : (best.isPaper ? null : takeToken(key));
      var res = award(best, key, bestOrder, src);
      emit(best, fmtPos(best.orig), fmtPos(key), bestOrder, 'Awarded', res.note);
      if (res.origin && res.origin !== key) proffer(res.origin);
    }
  }

  pilots.forEach(function (p) {
    var startPos = fmtPos(p.orig);

    if (p.isNoBid) {
      emit(p, startPos, startPos, 1, 'No Bid', 'Not allowed to bid. Remain in current position.');
      p.processed = true;
      return;
    }
    if (!p.prefs.length) {
      emit(p, startPos, startPos, 1, 'Awarded', 'Remain in current position.');
      p.processed = true;
      return;
    }
    if (!walkPreferences(p)) {
      emit(p, startPos, startPos, p.prefs[p.prefs.length - 1].order + 1, 'Awarded',
           'No preferences were available. Remain in current position.');
    }
    p.processed = true;
  });


  var phase1Count = transactions.length;
  var vacAfterPhase1 = {};
  Object.keys(vac).forEach(function (k) { vacAfterPhase1[k] = vac[k]; });

  // ── Phase 2 ─────────────────────────────────────────────────────────────
  var queue = [];
  function pushQueue(p) {
    queue.push(p);
    queue.sort(function (a, b) { return a.sen - b.sen; });
  }

  // Any position left over its cap sheds its junior overage.
  Object.keys(VALID).sort().forEach(function (key) {
    var over = -vac[key];
    if (over <= 0) return;
    var held = holdersAsc(key);
    var cut = held.slice(held.length - over);
    var keep = held.slice(0, held.length - over);
    var minSen = keep.length ? keep[keep.length - 1] : null;

    cut.forEach(function (sen) {
      var p = bySen[sen];
      exit(p);
      vac[key] += 1;
      emit(p, null, fmtPos(key), 'X', 'Reduction',
           'Seniority is not high enough to hold position due to reductions. ' +
           'Minimum position seniority is ' + minSen + '.');
    });
    cut.forEach(function (sen) { pushQueue(bySen[sen]); });
  });

  function blockedUpgrade(p, key) {
    if (UPGRADE_MIN_SEN === null) return false;
    var home = p.lastHeld || p.orig;
    return key.slice(-3) === '-CA' && home && home.slice(-3) === '-FO' &&
           p.sen >= UPGRADE_MIN_SEN;
  }

  // A displaced pilot takes `key` — by vacancy if there is one, otherwise by
  // seniority, bumping the junior pilot holding it.
  function takePosition(p, key, prefLabel) {
    if (vac[key] > 0) {
      var src = takeToken(key);
      var v0 = vac[key];
      vac[key] -= 1;
      enter(p, key);
      emit(p, null, fmtPos(key), prefLabel, 'Awarded',
           'Vacancy available. Reduce vacancy in 73G ' + fmtKey(key) + ' from ' + v0 +
           ' to ' + vac[key] + '. Proffered from ' + srcLabel(src) + '.');
      return true;
    }

    var junior = juniorAt(key);
    if (junior === null || p.sen >= junior) return false;

    var victim = bySen[junior];
    enter(p, key);
    emit(p, null, fmtPos(key), prefLabel, 'Awarded',
         'No vacancy, but seniority holds base. Award due to Reduction/Displacement. ' +
         'Displace ' + victim.sen + ' - ' + victim.name + '.');
    exit(victim);
    emit(victim, null, fmtPos(key), 'X', 'Displaced',
         'Could not hold base with seniority. Displaced by ' + p.sen + ' - ' + p.name);
    pushQueue(victim);
    return true;
  }

  function fallbackKeys(home) {
    var seat = home.split('-')[1];
    var other = seat === 'CA' ? 'FO' : 'CA';
    var out = [];
    FALLBACK_BASE_ORDER.forEach(function (b) {
      var k = makeKey(b, seat);
      if (VALID[k] && k !== home) out.push(k);
    });
    FALLBACK_BASE_ORDER.forEach(function (b) {
      var k = makeKey(b, other);
      if (VALID[k]) out.push(k);
    });
    return out;
  }

  var loops = 0;
  while (queue.length && loops < 20000) {
    loops++;
    var p = queue.shift();
    var awarded = false, lastKey = null;

    for (var i = 0; i < p.prefs.length; i++) {
      var pr = p.prefs[i], key = pr.key;

      if (!key) {
        lastKey = null;
        emit(p, null, null, pr.order, 'Denied',
             'Requested position is invalid. Position N/A does not exist.');
        continue;
      }
      lastKey = key;

      if (blockedUpgrade(p, key)) {
        emit(p, null, fmtPos(key), pr.order, 'Denied',
             'Invalid bid. Not upgraded due to 1000 hour cumulative flight time ' +
             'requirement. FOTM Bulletin 22-11.');
        continue;
      }
      if (takePosition(p, key, pr.order)) { awarded = true; break; }

      emit(p, null, fmtPos(key), pr.order, 'Denied',
           'Seniority is not high enough to hold position. Minimum position seniority is ' +
           juniorAt(key) + '.');
    }
    if (awarded) continue;

    // Bids exhausted — fall to 24.E.6.
    emit(p, null, fmtPos(lastKey), 'X', 'Insufficient Bids',
         'No bid options were available. Pilot position will be determined according to 24.E.6.');

    var home = p.lastHeld || p.orig;
    if (!home) continue;
    if (takePosition(p, home, '24.E.6')) continue;

    emit(p, null, fmtPos(home), '24.E.6', 'Denied',
         'Seniority is not high enough to hold position. Minimum position seniority is ' +
         juniorAt(home) + '.');

    var options = fallbackKeys(home);
    for (var f = 0; f < options.length; f++) {
      if (blockedUpgrade(p, options[f])) continue;
      if (takePosition(p, options[f], '24.E.6.b')) break;
    }
  }

  // ── Results ─────────────────────────────────────────────────────────────
  var targetMap = {}, currentCounts = {};
  Object.keys(VALID).forEach(function (k) {
    currentCounts[k] = Object.keys(occ[k]).length;
    targetMap[k] = Object.keys(occBid[k]).length + vac[k];
  });

  // Per-position roster in BPL order, with any remaining open slots appended
  // as VACANCY rows — this is what a "who's holding this base/seat, and how
  // many openings are left" list needs, on-manning pilots only (BPL population).
  var positions = {};
  Object.keys(VALID).forEach(function (key) {
    var holders = Object.keys(occBid[key]).map(Number).sort(function (a, b) { return a - b; })
      .map(function (sen) { return { sen: sen, name: bySen[sen].name }; });
    var open = Math.max(0, vac[key]);
    positions[key] = {
      base: key.split('-')[0],
      seat: key.split('-')[1],
      cap: targetMap[key],
      filled: holders.length,
      open: open,
      minSeniority: holders.length ? holders[holders.length - 1].sen : null,
      holders: holders
    };
  });

  var roster = pilots.map(function (p) {
    var last = p.rows[p.rows.length - 1] || {};
    var wasDisplaced = p.rows.some(function (r) {
      return r.status === 'Displaced' || r.status === 'Reduction';
    });
    return {
      sen: p.sen,
      name: p.name,
      orig: p.orig,
      currentKey: p.loc,
      finalPos: fmtPos(p.loc),
      awardedPrefNum: p.awardOrder,
      status: last.status || 'Awarded',
      note: last.note || '',
      moved: !!(p.loc && p.orig && p.loc !== p.orig),
      isPaper: p.isPaper,
      isNoBid: p.isNoBid,
      wasDisplaced: wasDisplaced,
      isUnassigned: p.loc === null && p.orig !== null,
      rows: p.rows
    };
  });

  return {
    transactions: transactions,
    roster: roster,
    vacancies: vac,
    vacanciesAfterPhase1: vacAfterPhase1,
    targetMap: targetMap,
    currentCounts: currentCounts,
    startCounts: startCounts,
    positions: positions,
    stats: {
      pilots: pilots.length,
      transactions: transactions.length,
      phase1Transactions: phase1Count,
      cascadeLoops: loops,
      awarded: transactions.filter(function (r) { return r.status === 'Awarded'; }).length,
      denied: transactions.filter(function (r) { return r.status === 'Denied'; }).length,
      noBid: transactions.filter(function (r) { return r.status === 'No Bid'; }).length,
      reductions: transactions.filter(function (r) { return r.status === 'Reduction'; }).length,
      displacements: transactions.filter(function (r) { return r.status === 'Displaced'; }).length,
      movers: roster.filter(function (r) { return r.moved; }).length,
      unassigned: roster.filter(function (r) { return r.isUnassigned; }).length
    }
  };
}

if (typeof module !== 'undefined' && module.exports) module.exports = runBidEngine;
