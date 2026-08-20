import React, { useState, useEffect, useRef } from "react";
import { supabase } from "./lib/supabase";
import { useRegisterSW } from "virtual:pwa-register/react";

const WINNING_SCORE = 500;
const LOSING_SCORE = -200;
const BAG_LIMIT = 10;
const BAG_PENALTY = -100;
const STORAGE_KEY = "spades_v13"; 
const HISTORY_KEY = "spades_history_v1";
const SETTINGS_KEY = "spades_settings_v1";
const INSTALL_DISMISSED_KEY = "bidtoset_install_dismissed_v1";
const INSTALL_SHOWN_KEY = "bidtoset_install_shown_v1";

const GOLD = "#c8a84e";
const RED = "#e05c5c";
const BLUE = "#00bfff";
const GREEN = "#6dbf8e";
const ORANGE = "#e8943a";
const BG = "#090d1b";
const DIM = "#080c18";
const PURPLE = "#9b59b6";

const DEFAULT_PLAYERS = ["Player 1", "Player 2", "Player 3", "Player 4"];

// ─── History Storage ──────────────────────────────────────────────────────────

function loadHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (_) { return []; }
}

function saveGameToHistory(gameData) {
  try {
    const history = loadHistory();
    // Dedupe guard: skip if the most recent entry is the same game written again
    // (e.g. impure state-updater firing twice under React StrictMode). Match on
    // final scores + round count + an id within a 5s window. A genuinely replayed
    // identical game minutes later will have an id far outside the window.
    // Deterministic dedupe: games carry a stable id (assigned at game start), so a
    // re-save (double-tap Confirm, StrictMode double-fire) REPLACES rather than adds.
    const existingIdx = history.findIndex(function(g) { return g && g.id === gameData.id; });
    if (existingIdx >= 0) history.splice(existingIdx, 1);
    // Heuristic fallback for legacy records that predate stable ids.
    const last = history[0];
    if (last && last.teams && gameData.teams &&
        last.teams.length === gameData.teams.length &&
        last.teams[0].score === gameData.teams[0].score &&
        last.teams[1].score === gameData.teams[1].score &&
        last.totalRounds === gameData.totalRounds &&
        Math.abs((last.id || 0) - (gameData.id || 0)) < 5000) {
      return;
    }
    history.unshift(gameData);
    if (history.length > 50) history.pop();
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  } catch (_) {}
}

const GAME_VIEW_BASE = "https://bidtoset.app/?recap=";
function gameViewUrl(code) { return GAME_VIEW_BASE + encodeURIComponent(code); }
function genShareCode() {
  try { return crypto.randomUUID(); }
  catch (_) { return "g" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
}

function buildGameRecord(gs, winner) {
  const now = new Date();
  return {
    id: (gs && gs.gameId) || now.getTime(),
    date: now.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }),
    time: now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }),
    teams: gs.teams.map(function(t) { return { name: t.name, score: t.score, bags: t.bags, p: [t.p[0], t.p[1]] }; }),
    winner: winner !== null ? gs.teams[winner].name : null,
    rounds: gs.rounds,
    totalRounds: gs.rounds.length,
  };
}


// ─── Cloud sync (Supabase) ─────────────────────────────────
// Local-first: localStorage stays the instant source of truth; the cloud push
// is best-effort background backup. Every failure is swallowed so the app keeps
// working fully offline. Idempotent upsert on (owner_id, client_id).
async function ensureAnonSession() {
  try {
    const { data } = await supabase.auth.getSession();
    if (!data || !data.session) await supabase.auth.signInAnonymously();
  } catch (_) {}
}
const CAST_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function genCastCode() {
  var s = "";
  try {
    var arr = new Uint8Array(6); crypto.getRandomValues(arr);
    for (var i = 0; i < 6; i++) s += CAST_ALPHABET[arr[i] % CAST_ALPHABET.length];
  } catch (_) { for (var j = 0; j < 6; j++) s += CAST_ALPHABET[Math.floor(Math.random() * CAST_ALPHABET.length)]; }
  return s;
}
async function ensureCastCode() {
  try {
    var code = null;
    try { code = localStorage.getItem("bidtoset_cast"); } catch (_) {}
    if (!code) { code = genCastCode(); try { localStorage.setItem("bidtoset_cast", code); } catch (_) {} }
    const { data } = await supabase.auth.getUser();
    const user = data && data.user;
    if (user) await supabase.from("cast_links").upsert({ code: code, owner_id: user.id }, { onConflict: "code", ignoreDuplicates: true });
    return code;
  } catch (_) { return null; }
}
async function pushGameToCloud(gameRecord, rules, winnerIndex) {
  try {
    const { data } = await supabase.auth.getUser();
    const user = data && data.user;
    if (!user || !gameRecord) return;
    const wIdx = (winnerIndex === 0 || winnerIndex === 1) ? winnerIndex : null;
    const { data: gRows } = await supabase.from("games").upsert({
      owner_id: user.id,
      client_id: gameRecord.id,
      played_at: new Date(gameRecord.id).toISOString(),
      winner_team: gameRecord.winner,          // legacy text (team name) — unchanged
      winning_team: wIdx,                      // v2 relational index (0/1)
      status: "completed",
      ended_at: new Date().toISOString(),
      total_rounds: gameRecord.totalRounds,
      teams: gameRecord.teams,
      // games.rounds (jsonb) is DEPRECATED and no longer written. rounds +
      // round_players are the source of truth. The jsonb copy only ever filled
      // in on the archive path, so it was present for ~40% of games and silently
      // absent for the rest - a duplicate you cannot trust is worse than none.
      rules: rules || null,
      share_code: gameRecord.shareCode || null,
    }, { onConflict: "owner_id,client_id" }).select("id").single();
    const gameId = gRows && gRows.id;
    if (gameId && wIdx !== null) {
      await pushRelationalGame(gameId, user.id, gameRecord, rules);
    }
  } catch (_) {}
}

// ─── Relational dual-write (Schema v2) ─────────────────────────────
// Best-effort, additive backup ALONGSIDE the jsonb push above. Populates
// players → game_participants → rounds → round_players so the event-grain
// stats views have real data. Nothing reads these yet, so every failure is
// swallowed exactly like the jsonb path; localStorage stays source of truth.
// Idempotent: players on (owner_id,name); participants on (game_id,seat);
// rounds on (game_id,round_number); round_players on (round_id,seat).
// Push local games the cloud has never seen. Games recorded before cloud sync
// existed - or during a spell when the archive silently failed - live only in
// this phone's localStorage. Matched on (owner_id, client_id), so re-running is
// safe and already-synced games are skipped.
async function cloudBackfillHistory(rules, onProgress) {
  try {
    const { data: u } = await supabase.auth.getUser();
    const user = u && u.user;
    if (!user) return { ok: false, reason: "not signed in" };
    const history = loadHistory();
    if (!history.length) return { ok: true, pushed: 0, skipped: 0 };
    const { data: existing, error } = await supabase.from("games")
      .select("client_id").eq("owner_id", user.id);
    if (error) return { ok: false, reason: error.message };
    const have = {};
    (existing || []).forEach(function (r) { if (r.client_id !== null && r.client_id !== undefined) have[String(r.client_id)] = true; });
    const todo = history.filter(function (g) { return !have[String(g.id)]; });
    var pushed = 0;
    for (var i = 0; i < todo.length; i++) {
      const g = todo[i];
      // winner is stored as a team NAME locally; map it back to an index.
      var wIdx = null;
      if (g.teams && g.teams.length === 2) {
        if (g.teams[0].name === g.winner) wIdx = 0;
        else if (g.teams[1].name === g.winner) wIdx = 1;
      }
      if (typeof g.winner === "number") wIdx = g.winner;
      await pushGameToCloud(g, (g.rules || rules), wIdx);
      pushed++;
      if (onProgress) onProgress(pushed, todo.length);
    }
    return { ok: true, pushed: pushed, skipped: history.length - todo.length };
  } catch (e) { return { ok: false, reason: (e && e.message) || "failed" }; }
}

async function pushRelationalGame(gameId, ownerId, gameRecord, rules) {
  try {
    const teams = gameRecord.teams;
    if (!teams || teams.length !== 2) return;
    // Seat geometry: team0 p0->0, team1 p0->1, team0 p1->2, team1 p1->3  (team = seat%2)
    const seatDefs = [
      { name: teams[0].p[0], team: 0, seat: 0 },
      { name: teams[1].p[0], team: 1, seat: 1 },
      { name: teams[0].p[1], team: 0, seat: 2 },
      { name: teams[1].p[1], team: 1, seat: 3 },
    ];
    if (seatDefs.some(function(s){ return !s.name; })) return;
    const uniqNames = Array.from(new Set(seatDefs.map(function(s){ return s.name; })));
    if (uniqNames.length !== 4) return; // duplicate names would collapse seats/participants

    // 1) players — upsert by name, map name -> id
    // players has UNIQUE (owner_id, lower(name)). Upserting on the CASE-SENSITIVE
    // index throws the moment a differently-cased row exists - "Robbie" against a
    // stored "robbie" - and the whole archive silently aborts. Same resolver the
    // live path uses, matched on lower(name).
    const seatToPlayerId = await cloudResolveSeatPlayerIds(ownerId, seatDefs);
    if (!seatToPlayerId) return;
    const idByName = {};
    seatDefs.forEach(function(sd){ idByName[sd.name] = seatToPlayerId[sd.seat]; });

    // 2) game_participants (4 rows)
    await supabase.from("game_participants").upsert(
      seatDefs.map(function(s){ return { game_id: gameId, player_id: idByName[s.name], team: s.team, seat: s.seat }; }),
      { onConflict: "game_id,seat" });

    // 3) rounds — event rows derived from the jsonb round log
    const rounds = gameRecord.rounds || [];
    const bagLimit = (rules && rules.bagLimit) ? rules.bagLimit : 10;
    const runningBags = [0, 0];
    const roundRows = [];
    for (var i = 0; i < rounds.length; i++) {
      const rd = rounds[i];
      const e = rd.entry, res = rd.results;
      if (!e || !res || e.length !== 2) { roundRows.push(null); continue; }
      const bid = [0, 0], tricks = [0, 0], pen = [0, 0];
      for (var ti = 0; ti < 2; ti++) {
        const en = e[ti];
        const p1b = en.p1nil > 0 ? 0 : (parseInt(en.p1bid) || 0);
        const p2b = en.p2nil > 0 ? 0 : (parseInt(en.p2bid) || 0);
        bid[ti] = p1b + p2b;
        tricks[ti] = (parseInt(en.p1tricks) || 0) + (parseInt(en.p2tricks) || 0);
        pen[ti] = (rd.penalties && rd.penalties[ti]) ? rd.penalties[ti] : 0;
        var carry = runningBags[ti] + ((res[ti] && res[ti].bags) ? res[ti].bags : 0);
        while (carry >= bagLimit) carry -= bagLimit;
        runningBags[ti] = carry;
      }
      var dealerSeat = null;
      if (rd.dealer) {
        var ds = seatDefs.find(function(s){ return s.name === rd.dealer; });
        dealerSeat = ds ? ds.seat : null;
      }
      roundRows.push({
        game_id: gameId,
        round_number: rd.num || (i + 1),
        dealer_seat: dealerSeat,
        team_0_bid: bid[0], team_1_bid: bid[1],
        team_0_tricks: tricks[0], team_1_tricks: tricks[1],
        team_0_score_delta: ((res[0] && res[0].pts) || 0) + pen[0],
        team_1_score_delta: ((res[1] && res[1].pts) || 0) + pen[1],
        team_0_bags_after: runningBags[0], team_1_bags_after: runningBags[1],
        team_0_bag_penalty_applied: pen[0], team_1_bag_penalty_applied: pen[1],
      });
    }
    // DB enforces team_0_tricks + team_1_tricks = 13; skip malformed rounds so
    // one bad hand never sinks the whole relational write (jsonb still has it).
    const validRoundRows = roundRows.filter(function(r){ return r && (r.team_0_tricks + r.team_1_tricks === 13); });
    if (validRoundRows.length === 0) return;
    const { data: rRows } = await supabase.from("rounds")
      .upsert(validRoundRows, { onConflict: "game_id,round_number" })
      .select("id,round_number");
    if (!rRows) return;
    const roundIdByNum = {};
    rRows.forEach(function(r){ roundIdByNum[r.round_number] = r.id; });

    // 4) round_players — 4 rows per successfully-written round
    const rpRows = [];
    for (var j = 0; j < rounds.length; j++) {
      const rd2 = rounds[j];
      const rnum = rd2.num || (j + 1);
      const roundId = roundIdByNum[rnum];
      if (!roundId || !rd2.entry) continue;
      for (var t2 = 0; t2 < 2; t2++) {
        const en2 = rd2.entry[t2];
        if (!en2) continue;
        const specs = [
          { seat: t2 === 0 ? 0 : 1, bidRaw: en2.p1bid, tricksRaw: en2.p1tricks, nil: en2.p1nil },
          { seat: t2 === 0 ? 2 : 3, bidRaw: en2.p2bid, tricksRaw: en2.p2tricks, nil: en2.p2nil },
        ];
        specs.forEach(function(sp){
          const nilType = sp.nil === 2 ? "blind_nil" : (sp.nil === 1 ? "nil" : null);
          const tricksTaken = parseInt(sp.tricksRaw) || 0;
          rpRows.push({
            round_id: roundId,
            player_id: seatToPlayerId[sp.seat],
            seat: sp.seat,
            bid: nilType ? 0 : (parseInt(sp.bidRaw) || 0),
            tricks_taken: tricksTaken,
            nil_type: nilType,
            nil_succeeded: nilType ? (tricksTaken === 0) : null,
          });
        });
      }
    }
    if (rpRows.length > 0) {
      await supabase.from("round_players").upsert(rpRows, { onConflict: "round_id,seat" });
    }
  } catch (_) {}
}

function hapticPulse(pattern) { try { if (navigator.vibrate) navigator.vibrate(pattern); } catch(_) {} }
function isRedditName(n) { if (!n) return false; const s = String(n).trim().toLowerCase(); return s === "reddit" || s === "snoo"; }

// ─── Player Analytics Engine ──────────────────────────────────────────────────

function buildPlayerStats(history) {
  const players = {};

  function getPlayer(name) {
    if (!players[name]) {
      players[name] = {
        name: name,
        games: 0, wins: 0,
        rounds: 0,
        totalBid: 0, totalTricks: 0, totalTricksForDW: 0, teamTotalTricksDW: 0,
        teamTotalTricks: 0,
        madeBid: 0, overBid: 0, underBid: 0,
        totalBags: 0,
        nilAttempts: 0, nilSuccess: 0,
        blindNilAttempts: 0, blindNilSuccess: 0,
        sets: 0,
      };
    }
    return players[name];
  }

  history.forEach(function(game) {
    if (!game || !game.teams) return;
    game.teams.forEach(function(team, ti) {
      if (!team || !team.p) return;
      var p1name = team.p[0];
      var p2name = team.p[1];
      var p1 = getPlayer(p1name);
      var p2 = getPlayer(p2name);

      p1.games++; p2.games++;
      if (game.winner === team.name) { p1.wins++; p2.wins++; }

      if (game.rounds) {
        game.rounds.forEach(function(round) {
          var entry = round.entry[ti];
          var result = round.results[ti];
          if (!entry || !result) return;

          p1.rounds++;
          if (entry.p1nil === 2) {
            p1.blindNilAttempts++;
            if (parseInt(entry.p1tricks) === 0) p1.blindNilSuccess++;
          } else if (entry.p1nil === 1) {
            p1.nilAttempts++;
            if (parseInt(entry.p1tricks) === 0) p1.nilSuccess++;
          } else {
            var b1 = parseInt(entry.p1bid) || 0;
            var t1 = parseInt(entry.p1tricks) || 0;
            p1.totalBid += b1;
            p1.totalTricks += t1;
            if (t1 === b1) p1.madeBid++;
            else if (t1 > b1) { p1.overBid++; p1.totalBags += (t1 - b1); }
            else p1.underBid++;
          }
          if (result.wasSet) p1.sets++;

          p2.rounds++;
          if (entry.p2nil === 2) {
            p2.blindNilAttempts++;
            if (parseInt(entry.p2tricks) === 0) p2.blindNilSuccess++;
          } else if (entry.p2nil === 1) {
            p2.nilAttempts++;
            if (parseInt(entry.p2tricks) === 0) p2.nilSuccess++;
          } else {
            var b2 = parseInt(entry.p2bid) || 0;
            var t2 = parseInt(entry.p2tricks) || 0;
            p2.totalBid += b2;
            p2.totalTricks += t2;
            if (t2 === b2) p2.madeBid++;
            else if (t2 > b2) { p2.overBid++; p2.totalBags += (t2 - b2); }
            else p2.underBid++;
          }
          if (result.wasSet) p2.sets++;

          var p1isNil = entry.p1nil > 0;
          var p2isNil = entry.p2nil > 0;
          var rawT1 = parseInt(entry.p1tricks) || 0;
          var rawT2 = parseInt(entry.p2tricks) || 0;
          var nonNilT1 = p1isNil ? 0 : rawT1;
          var nonNilT2 = p2isNil ? 0 : rawT2;
          var teamNonNil = nonNilT1 + nonNilT2;
          if (teamNonNil > 0) {
            if (!p1isNil) { p1.totalTricksForDW += nonNilT1; p1.teamTotalTricksDW += teamNonNil; }
            if (!p2isNil) { p2.totalTricksForDW += nonNilT2; p2.teamTotalTricksDW += teamNonNil; }
          }
          var teamTotal = rawT1 + rawT2;
          if (teamTotal > 0) {
            p1.teamTotalTricks += teamTotal;
            p2.teamTotalTricks += teamTotal;
          }
        });
      }
    });
  });

  Object.values(players).forEach(function(p) {
    var biddingRounds = p.madeBid + p.overBid + p.underBid;
    p.bidAccuracy = biddingRounds > 0 ? Math.round((p.madeBid / biddingRounds) * 100) : 0;
    p.sandbagRate = biddingRounds > 0 ? Math.round((p.overBid / biddingRounds) * 100) : 0;
    p.winRate = p.games > 0 ? Math.round((p.wins / p.games) * 100) : 0;
    p.nilRate = p.nilAttempts > 0 ? Math.round((p.nilSuccess / p.nilAttempts) * 100) : null;
    p.blindNilRate = p.blindNilAttempts > 0 ? Math.round((p.blindNilSuccess / p.blindNilAttempts) * 100) : null;
    p.avgBagsPerRound = biddingRounds > 0 ? (p.totalBags / biddingRounds).toFixed(1) : "0.0";
    p.isSandbagger = p.sandbagRate >= 50 && parseFloat(p.avgBagsPerRound) >= 1.0 && biddingRounds >= 8;
    p.deadWeightIndex = p.teamTotalTricksDW > 0 ? Math.round((p.totalTricksForDW / p.teamTotalTricksDW) * 100) : null;
    p.isDeadWeight = p.deadWeightIndex !== null && p.deadWeightIndex < 40 && p.rounds >= 5;
    p.isHeavyLifter = p.deadWeightIndex !== null && p.deadWeightIndex > 60 && p.rounds >= 5;
  });

  return Object.values(players).sort(function(a, b) { return b.games - a.games; });
}

// ─── Game Summary Analytics ───────────────────────────────────────────────────

function buildGameSummary(gs, rules) {
  // Collect per-player stats for this game only
  const playerMap = {};

  function getP(name) {
    if (!playerMap[name]) {
      playerMap[name] = { name: name, teamName: "", value: 0, trickTricks: 0, trickBidRounds: 0, bags: 0, rounds: 0, madeBid: 0, overBid: 0, underBid: 0, nilMade: 0, nilFailed: 0, blindMade: 0, blindFailed: 0 };
    }
    return playerMap[name];
  }

  gs.teams.forEach(function(team, ti) {
    var p1 = getP(team.p[0]); p1.teamName = team.name;
    var p2 = getP(team.p[1]); p2.teamName = team.name;

    gs.rounds.forEach(function(round) {
      var e = round.entry[ti];
      if (!e) return;
      var p1nil = e.p1nil > 0, p2nil = e.p2nil > 0;
      var t1 = parseInt(e.p1tricks) || 0, t2 = parseInt(e.p2tricks) || 0;
      var b1 = p1nil ? 0 : (parseInt(e.p1bid) || 0);
      var b2 = p2nil ? 0 : (parseInt(e.p2bid) || 0);
      var teamBid = b1 + b2;
      var bidTricks = (p1nil ? 0 : t1) + (p2nil ? 0 : t2);
      var bothNil = p1nil && p2nil;
      // Joint team-bid points (mirrors scoreTeam), then split by a blend of bid + trick share.
      var teamBidPts = 0;
      if (!bothNil) { teamBidPts = (bidTricks >= teamBid) ? (teamBid * 10 + (bidTricks - teamBid)) : (-teamBid * 10); }
      var nonNil = (p1nil ? 0 : 1) + (p2nil ? 0 : 1);
      function shareOf(isNil, myBid, myTricks) {
        if (isNil || nonNil === 0) return 0;
        var bidS = teamBid > 0 ? myBid / teamBid : 1 / nonNil;
        var trkS = bidTricks > 0 ? myTricks / bidTricks : 1 / nonNil;
        return (bidS + trkS) / 2;
      }
      function apply(p, nilState, isNil, tricks, myBid, sh) {
        p.rounds++;
        if (isNil) {
          var val = nilState === 2 ? 200 : 100;
          if (tricks === 0) { p.value += val; if (nilState === 2) p.blindMade++; else p.nilMade++; }
          else { p.value -= val; p.bags += tricks; if (nilState === 2) p.blindFailed++; else p.nilFailed++; }
        } else {
          p.value += teamBidPts * sh;
          p.trickBidRounds++; p.trickTricks += tricks;
          if (tricks === myBid) p.madeBid++;
          else if (tricks > myBid) { p.overBid++; p.bags += (tricks - myBid); }
          else p.underBid++;
        }
      }
      apply(p1, e.p1nil, p1nil, t1, b1, shareOf(p1nil, b1, t1));
      apply(p2, e.p2nil, p2nil, t2, b2, shareOf(p2nil, b2, t2));
    });
  });

  const allPlayers = Object.values(playerMap);

  allPlayers.forEach(function(p) {
    var br = p.madeBid + p.overBid + p.underBid;
    p.bidAccuracy = br > 0 ? Math.round((p.madeBid / br) * 100) : 0;
    p.sandbagRate = br > 0 ? Math.round((p.overBid / br) * 100) : 0;
    p.nilMades = p.nilMade + p.blindMade;
    p.nilFails = p.nilFailed + p.blindFailed;
    p.nilAttempts = p.nilMades + p.nilFails;
  });

  // MVP = highest nil-aware value (points put on the board); ties -> better bid accuracy.
  const mvp = allPlayers.reduce(function(best, p) {
    if (!best) return p;
    if (p.value > best.value) return p;
    if (p.value === best.value && p.bidAccuracy > best.bidAccuracy) return p;
    return best;
  }, null);

  // Cross-game sandbagger from history
  const history = loadHistory();
  const crossGameStats = buildPlayerStats(history);
  const sandbaggers = crossGameStats.filter(function(p) { return p.isSandbagger; });

  // Most bags this game
  const mostBagsPlayer = allPlayers.reduce(function(worst, p) { return (!worst || p.bags > worst.bags) ? p : worst; }, null);

  // Heavy Lifter / Dead Weight = trick-taking labor, measured only over rounds the player
  // actually bid tricks (nil rounds excluded), so a successful nil never reads as dead weight.
  const teamTrick = {};
  allPlayers.forEach(function(p) { teamTrick[p.teamName] = (teamTrick[p.teamName] || 0) + p.trickTricks; });
  allPlayers.forEach(function(p) {
    var tt = teamTrick[p.teamName] || 0;
    p.contribution = tt > 0 ? Math.round((p.trickTricks / tt) * 100) : 50;
  });
  const gameRounds = gs.rounds ? gs.rounds.length : 0;
  const enoughRounds = gameRounds >= 4;
  // Ineligible if the player nilled most of the game (they weren't trying for tricks).
  const eligible = allPlayers.filter(function(p) { return p.trickBidRounds > 0 && p.trickBidRounds >= Math.ceil(gameRounds / 2); });
  const byC = eligible.slice().sort(function(a, b) { return b.contribution - a.contribution; });
  const topC = byC[0], botC = byC[byC.length - 1];
  const heavyLifter = (enoughRounds && topC && topC.contribution >= 60) ? topC : null;
  const deadWeight = (enoughRounds && botC && topC && botC !== topC && botC.contribution <= 40) ? botC : null;

  // Nil recognition: celebrate a made nil / roast a blown one. Blind counts double.
  var nilMaster = null, nilBust = null;
  allPlayers.forEach(function(p) {
    var made = p.blindMade * 2 + p.nilMade;
    var fail = p.blindFailed * 2 + p.nilFailed;
    if (made > 0 && (!nilMaster || made > (nilMaster.blindMade * 2 + nilMaster.nilMade))) nilMaster = p;
    if (fail > 0 && (!nilBust || fail > (nilBust.blindFailed * 2 + nilBust.nilFailed))) nilBust = p;
  });

  return { allPlayers, mvp, sandbaggers, mostBagsPlayer, heavyLifter, deadWeight, nilMaster, nilBust };
}

// ─── Settings ─────────────────────────────────────────────────────────────────

// Bumped whenever the scoring MATH changes, so a stored game is self-describing
// and a stats query can tell which ruleset produced a given score.
//   1 = original. A busted nil's tricks counted as bags but scored no points.
//   2 = 2026-08-18. Standard rule adopted: a busted nil's tricks count as bags
//       AND pay 1 point each on a made contract; a set team scores -10 x bid
//       flat with no bag points, though the bags still count toward the penalty.
const SCORING_VERSION = 2;

const DEFAULT_SETTINGS = {
  winScore: 500,
  loseScore: -200,
  bagLimit: 10,
  bagPenalty: -100,
  minBid: 2,
  // 20s, not 25s. The table asked for 15s after a night of slow bidding, but
  // 15 has to cover BOTH the player deciding and the scorekeeper tapping it in.
  // Too short is a worse failure than too long: a clock that expires mid-entry
  // trains people to ignore it. 20 is the compromise. Anyone can still change it
  // in House Rules - this is only what a fresh install starts with.
  bidSeconds: 20,          // 0 = clock off
  scoringVersion: SCORING_VERSION,
};

// ─── Roster ───────────────────────────────────────────────────────────────────
// The saved pool of people who play at this table. Names are TYPED ONCE, here,
// and picked from every game after. That is the whole point: Mekenzie was
// entered as "Mek", "Mekenzie" and "Mekinzie" on her first night because four
// blank fields invite a fresh spelling every time.

const ROSTER_KEY = "spades_roster_v1";

function loadRoster() {
  try {
    const raw = localStorage.getItem(ROSTER_KEY);
    const a = raw ? JSON.parse(raw) : [];
    return Array.isArray(a) ? a.filter(function (n) { return n && String(n).trim(); }) : [];
  } catch (_) { return []; }
}

function saveRoster(list) {
  try { localStorage.setItem(ROSTER_KEY, JSON.stringify(list)); } catch (_) {}
}

// Case-insensitive add. Never creates a second row for a name already present.
function rosterAdd(list, name) {
  const nm = String(name || "").trim();
  if (!nm) return list;
  const hit = list.some(function (x) { return String(x).toLowerCase() === nm.toLowerCase(); });
  return hit ? list : list.concat([nm]);
}

function editDistance(a, b) {
  a = String(a).toLowerCase(); b = String(b).toLowerCase();
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = [], cur = [];
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = cur.slice();
  }
  return prev[n];
}

// "Did you mean Mekenzie?" - catches both misspellings and shortenings.
function nearMatch(name, list) {
  const nm = String(name || "").trim();
  if (nm.length < 3) return null;
  const low = nm.toLowerCase();
  for (let i = 0; i < list.length; i++) {
    const other = String(list[i]);
    const ol = other.toLowerCase();
    if (ol === low) return null;                                   // exact, not a near match
    if (ol.indexOf(low) === 0 || low.indexOf(ol) === 0) return other;   // Mek -> Mekenzie
    // ONE character apart only. Distance 2 flagged "Robbie" as "Debbie" - a false
    // positive on two real, different people, which is far worse than missing a
    // typo. Mekinzie -> Mekenzie is distance 1 and still caught.
    if (editDistance(low, ol) <= 1) return other;
  }
  return null;
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    // scoringVersion is never restored from storage - the running code decides
    // which rules it implements, so a stale saved value must not shadow it.
    return raw
      ? Object.assign({}, DEFAULT_SETTINGS, JSON.parse(raw), { scoringVersion: SCORING_VERSION })
      : Object.assign({}, DEFAULT_SETTINGS);
  } catch (_) { return Object.assign({}, DEFAULT_SETTINGS); }
}

function saveSettings(s) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch (_) {}
}

// ─── Auto-split ───────────────────────────────────────────────────────────────

function splitTeamName(name) {
  const separators = [" and ", " & ", " / "];
  for (var i = 0; i < separators.length; i++) {
    var sep = separators[i];
    var idx = name.toLowerCase().indexOf(sep.toLowerCase());
    if (idx > 0) {
      var p1 = name.substring(0, idx).trim();
      var p2 = name.substring(idx + sep.length).trim();
      if (p1.length > 0 && p2.length > 0) return [p1, p2];
    }
  }
  return null;
}

function isDefaultPlayerName(name) {
  return DEFAULT_PLAYERS.indexOf(name) !== -1;
}

// ─── Scoring ──────────────────────────────────────────────────────────────────

function scoreTeam(e) {
  const t1 = parseInt(e.p1tricks) || 0;
  const t2 = parseInt(e.p2tricks) || 0;
  const p1nil = e.p1nil > 0;
  const p2nil = e.p2nil > 0;
  const bothNil = p1nil && p2nil;
  const b1 = p1nil ? 0 : (parseInt(e.p1bid) || 0);
  const b2 = p2nil ? 0 : (parseInt(e.p2bid) || 0);
  const teamBid = b1 + b2;

  let pts = 0, bags = 0, nilBags = 0, lines = [], wasSet = false;

  [[p1nil, e.p1nil, t1], [p2nil, e.p2nil, t2]].forEach(function(arr) {
    const isNil = arr[0], state = arr[1], tricks = arr[2];
    if (!isNil) return;
    const blind = state === 2;
    const val = blind ? 200 : 100;
    if (tricks === 0) { pts += val; lines.push((blind ? "Blind Nil" : "Nil") + " made +" + val); }
    else {
      pts -= val;
      bags += tricks;
      nilBags += tricks;
      // Spell out the bags a busted nil creates. They were invisible before, which
      // made the bag counter look wrong - the tenth bag had nowhere to show itself.
      lines.push((blind ? "Blind Nil" : "Nil") + " failed -" + val + " (+" + tricks + " bag" + (tricks !== 1 ? "s" : "") + ")");
    }
  });

  if (!bothNil) {
    const bidTricks = (!p1nil ? t1 : 0) + (!p2nil ? t2 : 0);
    if (bidTricks >= teamBid) {
      const over = bidTricks - teamBid;
      // A busted nil's tricks are bags for the team, and a bag pays 1 point - but
      // only on a contract the team actually made. Standard rule ("Failed Nil:
      // takes bags" plus normal bag scoring).
      pts += teamBid * 10 + over + nilBags;
      bags += over;
      const shown = over + nilBags;
      lines.push(shown === 0 ? "Bid " + teamBid + " made" : "Bid " + teamBid + " +" + shown + " bag" + (shown !== 1 ? "s" : ""));
    } else {
      // Set: -10x bid flat. No bag points this round for anyone - though the
      // busted nil's bags still count toward the -100 threshold.
      pts -= teamBid * 10;
      wasSet = true;
      lines.push("Bid " + teamBid + " SET (took " + bidTricks + ")");
    }
  }

  return { pts, bags, lines, wasSet, teamBid };
}

function calcTeamBid(e) {
  const b1 = e.p1nil > 0 ? 0 : (parseInt(e.p1bid) || 0);
  const b2 = e.p2nil > 0 ? 0 : (parseInt(e.p2bid) || 0);
  return b1 + b2;
}

function calcTricksTotal(e) {
  const t1 = parseInt(e.p1tricks) || 0;
  const t2 = parseInt(e.p2tricks) || 0;
  return (e.p1nil === 0 ? t1 : 0) + (e.p2nil === 0 ? t2 : 0);
}

function isReady(e) {
  const p1bidOk = e.p1nil > 0 ? true : e.p1bid !== "";
  const p2bidOk = e.p2nil > 0 ? true : e.p2bid !== "";
  return p1bidOk && p2bidOk && e.p1tricks !== "" && e.p2tricks !== "";
}

// Per-team tricks — used for combined check only
function teamTricks(e) {
  const t1 = parseInt(e.p1tricks) || 0;
  const t2 = parseInt(e.p2tricks) || 0;
  return t1 + t2;
}

function teamTricksFilled(e) {
  return e.p1tricks !== "" && e.p2tricks !== "";
}

function bidOneViolation(e) {
  const bothNil = e.p1nil > 0 && e.p2nil > 0;
  if (bothNil) return false;
  const p1filled = e.p1nil > 0 || e.p1bid !== "";
  const p2filled = e.p2nil > 0 || e.p2bid !== "";
  return p1filled && p2filled && calcTeamBid(e) === 1;
}

function pendingSet(e) {
  const bothNil = e.p1nil > 0 && e.p2nil > 0;
  if (bothNil) return false;
  const bid = calcTeamBid(e);
  const tricks = calcTricksTotal(e);
  const p1filled = e.p1nil > 0 || e.p1bid !== "";
  const p2filled = e.p2nil > 0 || e.p2bid !== "";
  const tricksFilled = e.p1tricks !== "" && e.p2tricks !== "";
  return p1filled && p2filled && tricksFilled && bid > 0 && tricks < bid;
}

// ─── State ────────────────────────────────────────────────────────────────────

function blank() {
  return { p1bid: "", p2bid: "", p1nil: 0, p2nil: 0, p1tricks: "", p2tricks: "" };
}

function newGame(prev) {
  // Capture prior table for "Same table?" reuse prompt.
  // Only snapshot if prior table is non-default (real game was played).
  var lastTable = null;
  if (prev && prev.teams && prev.seating && prev.seating.dealer) {
    var t0name = prev.teams[0] && prev.teams[0].name;
    if (t0name && t0name !== "Team 1") {
      lastTable = {
        teams: [
          { name: prev.teams[0].name, p: [prev.teams[0].p[0], prev.teams[0].p[1]] },
          { name: prev.teams[1].name, p: [prev.teams[1].p[0], prev.teams[1].p[1]] },
        ],
        seating: Object.assign({}, prev.seating),
      };
    }
  }
  // Carry forward an existing lastTable if newGame is called twice without a played game in between.
  if (!lastTable && prev && prev.lastTable) lastTable = prev.lastTable;
  return {
    teams: [
      { name: "Team 1", score: 0, bags: 0, p: ["Player 1", "Player 2"] },
      { name: "Team 2", score: 0, bags: 0, p: ["Player 3", "Player 4"] },
    ],
    entry: [blank(), blank()],
    rounds: [], lastResult: null, winner: null, showHistory: false,
    seating: { N: null, S: null, E: null, W: null, dealer: null },
    activeBidSeat: null,
    activeTrickSeat: null,
    bidArmed: false,
    lastTable: lastTable,
  };
}

// A saved game whose `seating` names disagree with its `teams` names is broken in
// a quiet way: every seat lookup is by name, so a mismatch means bidding never
// advances, refs never register, and no keypad appears. States saved by builds
// before setPlayerName kept the two in sync can be in exactly that shape, so
// repair on load - keep the seats that match and hand the leftovers to the
// leftover names, by position.
function reconcileSeating(s) {
  try {
    if (!s || !s.seating || !s.teams || s.teams.length !== 2) return s;
    if (!s.teams[0].p || !s.teams[1].p) return s;
    var compass = ["N", "E", "S", "W"];
    var names = [s.teams[0].p[0], s.teams[0].p[1], s.teams[1].p[0], s.teams[1].p[1]];
    var seating = Object.assign({}, s.seating);
    var usedC = {}, usedN = {};
    compass.forEach(function (c) {
      for (var i = 0; i < names.length; i++) {
        if (!usedN[i] && names[i] === seating[c]) { usedC[c] = true; usedN[i] = true; return; }
      }
    });
    var freeC = compass.filter(function (c) { return !usedC[c]; });
    var freeN = names.filter(function (n, i) { return !usedN[i]; });
    if (!freeC.length) return s;
    freeC.forEach(function (c, k) { if (freeN[k] !== undefined) seating[c] = freeN[k]; });
    s.seating = seating;
  } catch (_) {}
  return s;
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      // Restore the hand in play. Fill any missing field from blank() so an entry
      // written by an older build can never come back half-shaped.
      if (!Array.isArray(s.entry) || s.entry.length !== 2) s.entry = [blank(), blank()];
      else s.entry = s.entry.map(function(e) { return Object.assign(blank(), e || {}); });
      s.lastResult = null;
      s.showHistory = false;
      return reconcileSeating(s);
    }
  } catch (_) {}
  return newGame();
}

function save(s) {
  try {
    // entry (bids/nils/tricks for the hand in play) MUST be persisted. It used to
    // be stripped, so any reload - iOS reclaiming the tab, a backgrounded PWA, a
    // service-worker update, a pull-to-refresh - wiped the bids clean. The window
    // is the whole hand: bids go in, 13 tricks get played, then tricks go in.
    localStorage.setItem(STORAGE_KEY, JSON.stringify(
      Object.assign({}, s, { lastResult: null, showHistory: false })
    ));
  } catch (_) {}
}

// ─── Nil helpers ──────────────────────────────────────────────────────────────

function cycleNil(n) { return (n + 1) % 3; }

function nilBtnStyle(n) {
  if (n === 2) return { background: BLUE, color: DIM, border: "1px solid " + BLUE, boxShadow: "0 0 10px rgba(0,191,255,0.5)" };
  if (n === 1) return { background: GOLD, color: DIM, border: "1px solid " + GOLD, boxShadow: "0 0 8px rgba(200,168,78,0.4)" };
  return { background: "rgba(255,255,255,0.08)", color: "#c8d8e8", border: "1px solid rgba(255,255,255,0.35)", boxShadow: "none" };
}

function nilLabel(n) {
  if (n === 2) return "BLIND NIL";
  if (n === 1) return "NIL BID";
  return "Bid NIL?";
}

function iStyle(extra) {
  return Object.assign({
    background: "rgba(255,255,255,0.08)",
    border: "1px solid rgba(255,255,255,0.35)",
    borderRadius: "8px", padding: "12px 8px",
    color: "#e8dcc8", fontSize: "18px",
    width: "100%", boxSizing: "border-box",
    textAlign: "center", fontFamily: "Georgia, serif",
    "--placeholder-color": "#8a9aaa",
  }, extra || {});
}

// ─── Editable name ────────────────────────────────────────────────────────────

function EditableName({ value, onChange, style }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const ref = useRef(null);

  function startEdit() { setDraft(value); setEditing(true); }

  function commit() {
    const v = draft.trim();
    onChange(v || value);
    setEditing(false);
  }

  useEffect(function() {
    if (editing && ref.current) { ref.current.focus(); ref.current.select(); }
  }, [editing]);

  if (editing) {
    return (
      <input ref={ref} value={draft}
        onChange={function(ev) { setDraft(ev.target.value); }}
        onBlur={commit}
        onKeyDown={function(ev) { if (ev.key === "Enter") { ev.preventDefault(); commit(); } if (ev.key === "Escape") setEditing(false); }}
        style={Object.assign({}, style, { background: "rgba(200,168,78,0.12)", border: "1px solid " + GOLD, borderRadius: "6px", padding: "3px 8px", color: GOLD, fontFamily: "Georgia, serif", outline: "none", width: "100%", boxSizing: "border-box", textAlign: style && style.textAlign ? style.textAlign : "left" })}
      />
    );
  }

  return (
    <div onClick={startEdit} style={Object.assign({}, style, { cursor: "pointer", userSelect: "none" })}>
      {value} <span style={{ fontSize: "9px", opacity: 0.65, fontStyle: "italic" }}>edit</span>
    </div>
  );
}

// ─── Player Row ───────────────────────────────────────────────────────────────

function PlayerRow({ name, onNameChange, nilState, bid, tricks, onToggleNil, onBid, onTricks, isActive, isTrickActive, onBidComplete, bidRef, isDealer, seat, bidRefs, trickRefs, onTricksComplete }) {
  const ns = nilBtnStyle(nilState);
  const isNil = nilState > 0;

  return (
    <div style={{ background: "rgba(0,0,0,0.2)", border: "1px solid " + (nilState === 2 ? "rgba(0,191,255,0.2)" : nilState === 1 ? "rgba(200,168,78,0.15)" : "rgba(255,255,255,0.05)"), borderRadius: "10px", padding: "11px 12px", display: "flex", flexDirection: "column", gap: "8px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", minHeight: "22px" }}>
        <EditableName value={name} onChange={onNameChange} style={{ fontSize: "12px", color: "#c8d8e8", letterSpacing: "1px", flex: 1 }} />         {isDealer && (<div style={{ fontSize: "9px", padding: "2px 8px", borderRadius: "4px", fontWeight: "bold", flexShrink: 0, marginLeft: "6px", background: "rgba(200,168,78,0.15)", color: GOLD, border: "1px solid rgba(200,168,78,0.4)", letterSpacing: "1px" }}>DEALER</div>)}
        {nilState > 0 && (
          <div style={{ fontSize: "9px", padding: "2px 8px", borderRadius: "4px", fontWeight: "bold", flexShrink: 0, marginLeft: "8px", background: nilState === 2 ? "rgba(0,191,255,0.15)" : "rgba(200,168,78,0.15)", color: nilState === 2 ? BLUE : GOLD }}>
            {nilState === 2 ? "BLIND +/-200" : "NIL +/-100"}
          </div>
        )}
      </div>

      <div style={{ display: "flex", gap: "8px" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          {isNil ? (
            <div style={{ background: nilState === 2 ? "rgba(0,191,255,0.1)" : "rgba(200,168,78,0.1)", border: "1px solid " + (nilState === 2 ? "rgba(0,191,255,0.3)" : "rgba(200,168,78,0.3)"), borderRadius: "8px", padding: "12px 8px", textAlign: "center", fontSize: "13px", color: nilState === 2 ? BLUE : GOLD, fontWeight: "bold" }}>BID: 0</div>
          ) : (
            <input type="number" inputMode="numeric" pattern="[0-9]*" min="0" max="13" placeholder="Bid" value={bid}
              ref={function(el){ if(bidRefs && seat){ bidRefs.current[seat] = el; } }}
              onChange={function(ev) { var v=ev.target.value; if(v===""||(parseInt(v)>=0&&parseInt(v)<=13)) { var wasEmpty = (bid===""); onBid(v); if(v!=="" && wasEmpty && isActive && onBidComplete) onBidComplete(); } }}
              style={iStyle({ borderColor: isActive ? "#00e5ff" : "rgba(200,168,78,0.85)", background: isActive ? "rgba(0,229,255,0.18)" : "rgba(200,168,78,0.14)", color: bid === "" ? "#8a9aaa" : "#e8dcc8", boxShadow: isActive ? "0 0 10px rgba(0,229,255,0.5)" : "none", transition: "all 0.2s" })} />
          )}
        </div>
        <button onClick={onToggleNil} style={Object.assign({ flex: 1, minWidth: 0, borderRadius: "8px", padding: "12px 6px", fontSize: "10px", fontFamily: "Georgia, serif", letterSpacing: "1px", textTransform: "uppercase", cursor: "pointer", fontWeight: "bold" }, ns)}>
          {nilLabel(nilState)}
        </button>
      </div>

      <input type="number" inputMode="numeric" pattern="[0-9]*" min="0" max="13" placeholder="Tricks taken" value={tricks}
        ref={function(el){ if(trickRefs && seat){ trickRefs.current[seat] = el; } }}
        onChange={function(ev) {
          var v=ev.target.value;
          if(v===""||(parseInt(v)>=0&&parseInt(v)<=13)) {
            var wasEmpty = (tricks==="");
            onTricks(v);
            // Same cadence as bidding: first entry in this box hands the cursor
            // to the next seat, so the scorer never reaches for the screen.
            if(v!=="" && wasEmpty && onTricksComplete) onTricksComplete(seat);
          }
        }}
        style={iStyle({
          borderColor: isTrickActive ? "#00e5ff" : (nilState === 2 ? "rgba(0,191,255,0.55)" : nilState === 1 ? "rgba(200,168,78,0.55)" : "rgba(255,255,255,0.35)"),
          background: isTrickActive ? "rgba(0,229,255,0.18)" : "rgba(255,255,255,0.08)",
          boxShadow: isTrickActive ? "0 0 10px rgba(0,229,255,0.5)" : "none",
          transition: "all 0.2s",
          color: tricks === "" ? "#8a9aaa" : "#e8dcc8" })} />
    </div>
  );
}

// ─── Team Card ────────────────────────────────────────────────────────────────

function TeamCard({ team, ti, entry, onToggleNil, onField, onTeamName, onPlayerName, activeP1, activeP2, onAdvanceBid, isDealerP1, isDealerP2, seatP1, seatP2, bidRefs, trickRefs, onAdvanceTrick, trickActiveP1, trickActiveP2 }) {
  const e = entry[ti];
  const bothNil = e.p1nil > 0 && e.p2nil > 0;
  const total = calcTeamBid(e);
  const bidOver13 = total > 13;
  const warn = bidOneViolation(e);
  const setAlert = pendingSet(e);
  const p1filled = e.p1nil > 0 || e.p1bid !== "";
  const p2filled = e.p2nil > 0 || e.p2bid !== "";
  const hasBids = p1filled && p2filled;
  const tricksTaken = calcTricksTotal(e);

  return (
    <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid " + (setAlert ? ORANGE : warn ? RED : "rgba(200,168,78,0.18)"), borderRadius: "12px", padding: "14px", display: "flex", flexDirection: "column", gap: "10px", boxShadow: setAlert ? "0 0 16px rgba(232,148,58,0.25)" : "none" }}>
      <EditableName value={team.name} onChange={onTeamName} style={{ fontSize: "14px", color: GOLD, textAlign: "center", fontVariant: "small-caps", letterSpacing: "1px", width: "100%" }} />

      {(isDefaultPlayerName(team.p[0]) || isDefaultPlayerName(team.p[1])) && (
        <div style={{ fontSize: "10px", color: "#7abf9a", textAlign: "center", fontStyle: "italic" }}>
          Tip: type "Name and Name" as team name to auto-fill players
        </div>
      )}

      {!bothNil && (
        <div style={{ background: setAlert ? "rgba(232,148,58,0.1)" : hasBids ? "rgba(200,168,78,0.08)" : "rgba(255,255,255,0.03)", border: "1px solid " + (setAlert ? ORANGE : warn ? RED : hasBids ? "rgba(200,168,78,0.3)" : "rgba(255,255,255,0.08)"), borderRadius: "8px", padding: "10px 14px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontSize: "11px", color: "#c8d8e8", letterSpacing: "2px" }}>TEAM BID</div>
          <div style={{ fontSize: "28px", fontWeight: "bold", color: bidOver13 ? RED : setAlert ? ORANGE : warn ? RED : hasBids ? GOLD : "#3a4a5a" }}>{hasBids ? total : "-"}</div>
          {bidOver13 && <div style={{ fontSize: "10px", color: RED, fontWeight: "bold" }}>MAX 13</div>}
            {warn && !setAlert && !bidOver13 && <div style={{ fontSize: "10px", color: RED, fontWeight: "bold" }}>MIN 2</div>}
          {setAlert && <div style={{ fontSize: "10px", color: ORANGE, fontWeight: "bold" }}>SET!</div>}
        </div>
      )}

      {setAlert && (
        <div style={{ background: ORANGE, color: DIM, borderRadius: "8px", padding: "10px 14px", textAlign: "center", fontWeight: "bold", fontSize: "13px", letterSpacing: "1px", animation: "flashOrange 1s ease-in-out infinite" }}>
          SET - bid {total}, took {tricksTaken} - minus {total * 10} pts
        </div>
      )}

      {bothNil && (
        <div style={{ background: "rgba(200,168,78,0.05)", border: "1px solid rgba(200,168,78,0.1)", borderRadius: "8px", padding: "10px 12px", textAlign: "center", fontSize: "11px", color: "#4a5a6a" }}>
          Both nil - no team bid
        </div>
      )}

      <div style={{ borderTop: "1px solid rgba(255,255,255,0.05)" }} />

      <PlayerRow name={team.p[0]} onNameChange={function(v) { onPlayerName(ti, 0, v); }} nilState={e.p1nil} bid={e.p1bid} tricks={e.p1tricks} onToggleNil={function() { onToggleNil(ti, 1); }} onBid={function(v) { onField(ti, "p1bid", v); }} onTricks={function(v) { onField(ti, "p1tricks", v); }} isActive={activeP1} isTrickActive={trickActiveP1} onBidComplete={onAdvanceBid} isDealer={isDealerP1} seat={seatP1} bidRefs={bidRefs} trickRefs={trickRefs} onTricksComplete={onAdvanceTrick} />
      <PlayerRow name={team.p[1]} onNameChange={function(v) { onPlayerName(ti, 1, v); }} nilState={e.p2nil} bid={e.p2bid} tricks={e.p2tricks} onToggleNil={function() { onToggleNil(ti, 2); }} onBid={function(v) { onField(ti, "p2bid", v); }} onTricks={function(v) { onField(ti, "p2tricks", v); }} isActive={activeP2} isTrickActive={trickActiveP2} onBidComplete={onAdvanceBid} isDealer={isDealerP2} seat={seatP2} bidRefs={bidRefs} trickRefs={trickRefs} onTricksComplete={onAdvanceTrick} />

      {warn && !setAlert && (
        <div style={{ background: RED, color: DIM, fontSize: "11px", fontWeight: "bold", textAlign: "center", padding: "9px", borderRadius: "7px", textTransform: "uppercase", letterSpacing: "1px" }}>
          Team bid of 1 not allowed - confirm with table
        </div>
      )}
    </div>
  );
}

// ─── Result Card ──────────────────────────────────────────────────────────────

function ResultCard({ result }) {
  return (
    <div style={{ background: "rgba(109,191,142,0.06)", border: "1px solid rgba(109,191,142,0.45)", borderRadius: "12px", padding: "14px" }}>
      <div style={{ fontSize: "10px", letterSpacing: "3px", color: GREEN, marginBottom: "10px", textAlign: "center" }}>ROUND {result.round} RESULT</div>
      <div style={{ display: "flex", gap: "10px" }}>
        {result.teams.map(function(t, i) {
          return (
            <div key={i} style={{ flex: 1, textAlign: "center", background: t.wasSet ? "rgba(232,148,58,0.08)" : "rgba(109,191,142,0.05)", border: "1px solid " + (t.wasSet ? "rgba(232,148,58,0.5)" : "rgba(109,191,142,0.4)"), borderRadius: "10px", padding: "10px 8px" }}>
              <div style={{ fontSize: "11px", color: t.wasSet ? ORANGE : GOLD, fontWeight: "bold", marginBottom: "6px" }}>{t.name}{t.wasSet ? " SET" : ""}</div>
              {t.lines.map(function(l, li) {
                const isBad = l.indexOf("SET") !== -1 || l.indexOf("failed") !== -1;
                const isBlind = l.indexOf("Blind") !== -1;
                return <div key={li} style={{ fontSize: "11px", color: isBad ? ORANGE : isBlind ? BLUE : GREEN, marginBottom: "2px" }}>{l}</div>;
              })}
              <div style={{ fontSize: "24px", fontWeight: "bold", color: t.pts >= 0 ? GREEN : RED, marginTop: "8px", marginBottom: "2px" }}>{t.pts >= 0 ? "+" : ""}{t.pts}</div>
              <div style={{ fontSize: "10px", color: "#c0d0e0" }}>Running: {t.score}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Game Summary Card ────────────────────────────────────────────────────────







function InstallPrompt({ gameJustEnded }) {
  const [deferredEvent, setDeferredEvent] = React.useState(null);
  const [visible, setVisible] = React.useState(false);
  const [showIOSHelp, setShowIOSHelp] = React.useState(false);

  // Detect iOS Safari (no beforeinstallprompt support)
  const isIOS = React.useMemo(function() {
    if (typeof navigator === "undefined") return false;
    return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
  }, []);

  // Detect already-installed (standalone mode)
  const isStandalone = React.useMemo(function() {
    if (typeof window === "undefined") return false;
    return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
  }, []);

  // Listen for Android install opportunity
  React.useEffect(function() {
    function handler(e) {
      e.preventDefault();
      setDeferredEvent(e);
    }
    window.addEventListener("beforeinstallprompt", handler);
    return function() { window.removeEventListener("beforeinstallprompt", handler); };
  }, []);

  // Decide whether to show when a game ends
  React.useEffect(function() {
    if (!gameJustEnded) return;
    if (isStandalone) return;
    try {
      if (localStorage.getItem(INSTALL_DISMISSED_KEY) === "1") return;
      // Only show if we can actually prompt (Android) OR this is iOS
      if (!deferredEvent && !isIOS) return;
      setVisible(true);
      localStorage.setItem(INSTALL_SHOWN_KEY, "1");
    } catch(_) {}
  }, [gameJustEnded, deferredEvent, isIOS, isStandalone]);

  function dismiss() {
    setVisible(false);
    try { localStorage.setItem(INSTALL_DISMISSED_KEY, "1"); } catch(_) {}
  }

  function install() {
    if (isIOS) {
      setShowIOSHelp(true);
      return;
    }
    if (!deferredEvent) return;
    deferredEvent.prompt();
    deferredEvent.userChoice.then(function(choice) {
      if (choice.outcome === "accepted") {
        setVisible(false);
      }
      setDeferredEvent(null);
    });
  }

  if (!visible) return null;

  return (
    <div style={{ marginTop: "14px", background: "linear-gradient(135deg, rgba(200,168,78,0.12), rgba(200,168,78,0.06))", border: "1px solid rgba(200,168,78,0.5)", borderRadius: "12px", padding: "14px", animation: "toastIn 0.5s ease-out" }}>
      {!showIOSHelp ? (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "10px" }}>
            <div style={{ fontSize: "22px" }}>♠</div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: "12px", color: GOLD, fontWeight: "bold", letterSpacing: "1px" }}>ADD TO HOME SCREEN</div>
              <div style={{ fontSize: "10px", color: "#8a9aaa", marginTop: "2px" }}>Offline play, no browser chrome.</div>
            </div>
          </div>
          <div style={{ display: "flex", gap: "8px" }}>
            <button onClick={install} style={{ flex: 1, background: GOLD, color: DIM, border: "none", borderRadius: "8px", padding: "10px", fontSize: "11px", fontWeight: "bold", letterSpacing: "1px", cursor: "pointer", fontFamily: "Georgia, serif" }}>
              {isIOS ? "Show Me How" : "Install"}
            </button>
            <button onClick={dismiss} style={{ background: "transparent", color: "#8a9aaa", border: "1px solid rgba(138,154,170,0.3)", borderRadius: "8px", padding: "10px 14px", fontSize: "11px", cursor: "pointer", letterSpacing: "1px" }}>
              Not Now
            </button>
          </div>
        </>
      ) : (
        <>
          <div style={{ fontSize: "12px", color: GOLD, fontWeight: "bold", letterSpacing: "1px", marginBottom: "8px" }}>INSTALL ON IPHONE</div>
          <div style={{ fontSize: "11px", color: "#c8d8e8", lineHeight: 1.6, marginBottom: "10px" }}>
            1. Tap the <span style={{ color: GOLD }}>Share button</span> (square with arrow) at the bottom of Safari<br/>
            2. Scroll down and tap <span style={{ color: GOLD }}>"Add to Home Screen"</span><br/>
            3. Tap <span style={{ color: GOLD }}>"Add"</span> in the top right
          </div>
          <button onClick={dismiss} style={{ width: "100%", background: "transparent", color: GOLD, border: "1px solid " + GOLD, borderRadius: "8px", padding: "10px", fontSize: "11px", cursor: "pointer", letterSpacing: "1px", fontFamily: "Georgia, serif" }}>
            Got It
          </button>
        </>
      )}
    </div>
  );
}

function BigJokerSpade() {
  const [taps, setTaps] = React.useState(0);
  const [show, setShow] = React.useState(false);
  const timerRef = React.useRef(null);
  function onTap() {
    if (timerRef.current) clearTimeout(timerRef.current);
    const next = taps + 1;
    setTaps(next);
    if (next >= 5) {
      setTaps(0); setShow(true);
      hapticPulse([40,30,40,30,100]);
      setTimeout(function(){ setShow(false); }, 2000);
    } else {
      timerRef.current = setTimeout(function(){ setTaps(0); }, 900);
    }
  }
  return (
    <>
      <div onClick={onTap} style={{ fontSize: "32px", lineHeight: 1, marginBottom: "6px", cursor: "pointer", userSelect: "none" }}>♠</div>
      {show && (
        <div style={{ position: "fixed", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none", zIndex: 999 }}>
          <div style={{ background: "linear-gradient(135deg, #c8a84e, #fff0c0, #c8a84e)", color: "#1a1208", padding: "40px 30px", borderRadius: "16px", fontFamily: "Georgia, serif", textAlign: "center", boxShadow: "0 0 80px rgba(200,168,78,0.8)", animation: "jokerSlide 2s ease-in-out" }}>
            <div style={{ fontSize: "60px" }}>🃏</div>
            <div style={{ fontSize: "20px", fontWeight: "bold", letterSpacing: "4px", marginTop: "8px" }}>BIG JOKER</div>
          </div>
        </div>
      )}
    </>
  );
}

function RenegadeIcon() {
  const [open, setOpen] = React.useState(false);
  return (
    <span style={{ display: "inline-block", marginLeft: "6px", cursor: "pointer", fontSize: "10px" }} onClick={function(e){ e.stopPropagation(); setOpen(function(v){return !v;}); }}>
      🔍
      {open && <div style={{ fontSize: "9px", color: "#9b59b6", fontStyle: "italic", marginTop: "2px" }}>Checking the books... you sure you didn't reneg?</div>}
    </span>
  );
}

function MercyRuleBanner({ teams, onConcede }) {
  const [msgOpen, setMsgOpen] = React.useState(false);
  if (!teams || teams.length !== 2) return null;
  const spread = Math.abs(teams[0].score - teams[1].score);
  if (spread < 200) return null;
  const loserIdx = teams[0].score < teams[1].score ? 0 : 1;
  const winnerIdx = loserIdx === 0 ? 1 : 0;
  const loser = teams[loserIdx], winner = teams[winnerIdx];
  return (
    <div style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.15)", borderRadius: "10px", padding: "8px 12px", display: "flex", alignItems: "center", justifyContent: "center", gap: "10px", animation: "toastIn 0.4s ease-out" }}>
      <div style={{ fontSize: "16px", cursor: "pointer" }} onClick={function(){ setMsgOpen(function(v){return !v;}); }}>🏳️</div>
      <div style={{ fontSize: "10px", color: "#8a9aaa", letterSpacing: "1px", flex: 1 }}>
        {msgOpen ? ("It's okay to quit. We won't tell Reddit.") : (loser.name + " down " + spread + " — surrender?")}
      </div>
      {onConcede && (
        <button
          onClick={function(){
            if (confirm(loser.name + " concede?\n\n" + winner.name + " take the win at " + winner.score + " - " + loser.score + ".")) onConcede(winnerIdx);
          }}
          style={{ flexShrink: 0, background: "rgba(224,92,92,0.18)", color: "#e05c5c", border: "1px solid rgba(224,92,92,0.55)", borderRadius: "8px", padding: "7px 12px", fontSize: "10px", fontWeight: "bold", letterSpacing: "1px", cursor: "pointer", fontFamily: "Georgia, serif" }}>
          CONCEDE
        </button>
      )}
    </div>
  );
}


function BagLadyWarning({ teams, bagLimit }) {
  const danger = teams.filter(function(t) { return t.bags >= (bagLimit - 1) && t.bags < bagLimit; });
  React.useEffect(function() { if (danger.length > 0) hapticPulse(25); }, [danger.length]);
  if (danger.length === 0) return null;
  return (
    <div style={{ background: "rgba(224,92,92,0.15)", border: "1px solid rgba(224,92,92,0.7)", borderRadius: "10px", padding: "10px 14px", textAlign: "center", animation: "bagPulse 1.4s ease-in-out infinite, toastIn 0.4s ease-out" }}>
      <div style={{ fontSize: "10px", color: "#e05c5c", letterSpacing: "2px", fontWeight: "bold", marginBottom: "2px" }}>⚠ BAG LADY ALERT</div>
      <div style={{ fontSize: "11px", color: "#c88080", fontStyle: "italic" }}>
        {danger.map(function(t){return t.name;}).join(" & ")} — one book from a {bagLimit * -10} disaster.
      </div>
    </div>
  );
}

function SandbaggerBadge({ player, rules }) {
  const [revealed, setRevealed] = React.useState(false);
  const timerRef = React.useRef(null);
  const pointsLost = (player.totalBags || 0) * 1 + Math.floor((player.totalBags || 0) / (rules && rules.bagLimit ? rules.bagLimit : 10)) * 100;
  function start() { timerRef.current = setTimeout(function(){ setRevealed(true); hapticPulse([8,12,8,12,8]); }, 600); }
  function cancel() { if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; } }
  return (
    <div onMouseDown={start} onMouseUp={cancel} onMouseLeave={cancel} onTouchStart={start} onTouchEnd={cancel}
      style={{ fontSize: "10px", padding: "3px 8px", borderRadius: "4px", background: revealed ? "rgba(224,92,92,0.25)" : "rgba(232,148,58,0.2)", color: revealed ? "#e05c5c" : "#e8943a", fontWeight: "bold", letterSpacing: "1px", cursor: "pointer", userSelect: "none", transition: "all 0.3s" }}>
      {revealed ? ("−" + pointsLost + " PTS LOST") : "SANDBAGGER"}
    </div>
  );
}

function GameSummaryCard({ gs, rules, onDismiss }) {
  const hadBoston = gs.rounds.some(function(r) {
    return r.results && r.entry && [0,1].some(function(ti) {
      var e = r.entry[ti] || {}; var b1 = parseInt(e.p1bid||0); var b2 = parseInt(e.p2bid||0);
      return (b1 + b2) === 13 && r.results[ti] && r.results[ti].pts > 0;
    });
  });
  React.useEffect(function() { if (hadBoston) hapticPulse([40,30,40,30,120]); }, [hadBoston]);
  const [showQR, setShowQR] = React.useState(false);
  const summary = buildGameSummary(gs, rules);
  const winner = gs.winner !== null ? gs.teams[gs.winner] : null;
  const loser = gs.winner !== null ? gs.teams[gs.winner === 0 ? 1 : 0] : null;

  function copyToClipboard() {
    const lines = [
      "♠ BidToSet Game Summary ♠",
      "─────────────────────────",
      winner ? (winner.name + " " + winVerb(winner.name).toUpperCase() + " " + winner.score + " - " + loser.score) : "Game Over",
      gs.rounds.length + " rounds played",
      "",
      "🏆 MVP: " + summary.mvp.name + " (" + summary.mvp.bidAccuracy + "% bid accuracy)",
      summary.mostBagsPlayer.bags > 0 ? ("🎒 Most Bags: " + summary.mostBagsPlayer.name + " (" + summary.mostBagsPlayer.bags + " bags)") : "",
      summary.heavyLifter ? ("💪 Heavy Lifter: " + summary.heavyLifter.name + " (" + summary.heavyLifter.contribution + "% of team tricks)") : "",
      summary.deadWeight ? ("⚓ Dead Weight: " + summary.deadWeight.name + " (" + summary.deadWeight.contribution + "% of team tricks)") : "",
      summary.nilMaster ? ("🎯 Nil Master: " + summary.nilMaster.name) : "",
      summary.nilBust ? ("💥 Blew the Nil: " + summary.nilBust.name) : "",
      summary.sandbaggers.length > 0 ? ("⚠️ Sandbagger Alert: " + summary.sandbaggers.map(function(p) { return p.name; }).join(", ")) : "",
      "",
      gs.shareCode ? ("Full recap: " + gameViewUrl(gs.shareCode)) : "",
      "bidtoset.app",
    ].filter(Boolean).join("\n");

    try {
      navigator.clipboard.writeText(lines);
    } catch (_) {}
  }

  function shareGame() {
    if (!gs.shareCode) return;
    const link = gameViewUrl(gs.shareCode);
    const text = (winner ? (winner.name + " won " + winner.score + "-" + loser.score) : "Game over") + " \u2014 BidToSet recap";
    try {
      if (navigator.share) { navigator.share({ title: "BidToSet Game Recap", text: text, url: link }).catch(function() {}); }
      else { navigator.clipboard.writeText(link); }
    } catch (_) {}
  }

  function drawRecapCanvas() {
    const W = 1080, H = 1350, cx = W / 2;
    const cv = document.createElement("canvas");
    cv.width = W; cv.height = H;
    const g = cv.getContext("2d");
    g.fillStyle = "#0a0e1b"; g.fillRect(0, 0, W, H);
    g.strokeStyle = "rgba(200,168,78,0.55)"; g.lineWidth = 6; g.strokeRect(26, 26, W - 52, H - 52);
    function center(str, y, size, color, weight, font) {
      g.textAlign = "center"; g.fillStyle = color;
      g.font = ((weight ? weight + " " : "") + size + "px " + (font || "Georgia, serif"));
      g.fillText(str, cx, y);
    }
    center("♠", 150, 84, "#c8a84e", "");
    center("BIDTOSET", 225, 46, "#c8a84e", "bold");
    center("GAME RECAP", 268, 26, "#6a7a8a", "", "Arial, sans-serif");
    if (winner) {
      center("WINNER", 390, 30, "#a08040", "bold", "Arial, sans-serif");
      center(winner.name, 460, 60, "#c8a84e", "bold");
      center(String(winner.score), 575, 118, "#c8a84e", "bold");
      center("vs " + loser.name + " — " + loser.score, 640, 32, "#8a9aaa", "", "Arial, sans-serif");
      center(gs.rounds.length + " rounds", 685, 26, "#5a6a7a", "", "Arial, sans-serif");
    }
    let y = 770;
    function row(label, name, detail, color) {
      g.textAlign = "left";
      g.fillStyle = color; g.font = "bold 28px Arial, sans-serif"; g.fillText(label, 130, y);
      g.fillStyle = "#e6edf5"; g.font = "bold 44px Georgia, serif"; g.fillText(name, 130, y + 52);
      g.fillStyle = "#8a9aaa"; g.font = "26px Arial, sans-serif"; g.fillText(detail, 130, y + 92);
      y += 120;
    }
    if (summary.mvp) row("MVP", summary.mvp.name, (summary.mvp.nilMades > 0 ? (summary.mvp.nilMades + " nil" + (summary.mvp.nilMades > 1 ? "s" : "") + " made") : (summary.mvp.bidAccuracy + "% bid accuracy")), "#6dbf8e");
    if (summary.heavyLifter) row("HEAVY LIFTER", summary.heavyLifter.name, summary.heavyLifter.contribution + "% of team tricks", "#6dbf8e");
    if (summary.deadWeight) row("DEAD WEIGHT", summary.deadWeight.name, summary.deadWeight.contribution + "% of team tricks", "#e05c5c");
    if (summary.mostBagsPlayer && summary.mostBagsPlayer.bags > 0) row("MOST BAGS", summary.mostBagsPlayer.name, summary.mostBagsPlayer.bags + " bags", "#e8943a");
    center("Score your own at bidtoset.app", H - 70, 32, "#c8a84e", "bold", "Arial, sans-serif");
    return cv;
  }

  const [recapPreview, setRecapPreview] = React.useState(null);

  function shareRecapImage() {
    try {
      const cv = drawRecapCanvas();
      cv.toBlob(function(blob) {
        if (!blob) return;
        const file = new File([blob], "bidtoset-recap.png", { type: "image/png" });
        const caption = (winner ? (winner.name + " won " + winner.score + "-" + loser.score) : "Game over") + " \u2014 played on BidToSet";
        if (navigator.canShare && navigator.canShare({ files: [file] }) && navigator.share) {
          navigator.share({ files: [file], title: "BidToSet Game Recap", text: caption }).catch(function() {});
        } else {
          // Desktop / no file-share: SHOW the graphic so it's visible + saveable.
          setRecapPreview(cv.toDataURL("image/png"));
        }
      }, "image/png");
    } catch (_) {}
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.85)", zIndex: 300, display: "flex", alignItems: "flex-start", justifyContent: "center", overflowY: "auto", WebkitOverflowScrolling: "touch", padding: "40px 20px 160px 20px", backdropFilter: "blur(8px)", animation: "fadeIn 0.4s ease-out" }}
      onClick={onDismiss}>
      <div onClick={function(e) { e.stopPropagation(); }}
        style={{ background: "linear-gradient(145deg, #0d1528, #090d1b)", border: "1px solid " + GOLD, borderRadius: "18px", padding: "24px", width: "100%", maxWidth: "400px", boxShadow: "0 0 60px rgba(200,168,78,0.3)" }}>

        {/* Header */}
        <div style={{ textAlign: "center", marginBottom: "20px" }}>
          <BigJokerSpade />
          <div style={{ fontSize: "20px", color: GOLD, fontVariant: "small-caps", letterSpacing: "3px" }}>Game Summary</div>
          <div style={{ fontSize: "11px", color: "#6a7a8a", marginTop: "4px" }}>bidtoset.app</div>
        </div>
        {hadBoston && (
          <div style={{ background: "linear-gradient(135deg, #c8a84e, #e8c878, #c8a84e)", color: "#1a1208", textAlign: "center", padding: "14px 10px", borderRadius: "12px", marginBottom: "14px", fontFamily: "Georgia, serif", letterSpacing: "2px", animation: "goldFlood 0.8s ease-out", boxShadow: "0 0 40px rgba(200,168,78,0.6)" }}>
            <div style={{ fontSize: "11px", letterSpacing: "4px", opacity: 0.7 }}>★ CLEAN SWEEP ★</div>
            <div style={{ fontSize: "22px", fontWeight: "bold", margin: "4px 0" }}>BOSTON</div>
            <div style={{ fontSize: "10px", fontStyle: "italic", opacity: 0.75 }}>All 13 tricks. Hang the broom.</div>
          </div>
        )}

        {/* Winner */}
        {winner && (
          <div style={{ background: "linear-gradient(135deg, rgba(200,168,78,0.15), rgba(200,168,78,0.25))", border: "1px solid " + GOLD, borderRadius: "12px", padding: "16px", textAlign: "center", marginBottom: "16px" }}>
            <div style={{ fontSize: "11px", color: "#a08040", letterSpacing: "3px", marginBottom: "4px" }}>WINNER</div>
            <div style={{ fontSize: "22px", color: GOLD, fontWeight: "bold" }}>{winner.name}</div>
            <div style={{ fontSize: "32px", fontWeight: "bold", color: GOLD, lineHeight: 1.2 }}>{winner.score}</div>
            <div style={{ fontSize: "13px", color: "#6a7a8a", marginTop: "4px" }}>vs {loser.name} — {loser.score}</div>
            <div style={{ fontSize: "11px", color: "#4a5a6a", marginTop: "4px" }}>{gs.rounds.length} rounds</div>
          </div>
        )}

        {/* MVP */}
        <div style={{ background: "rgba(109,191,142,0.08)", border: "1px solid rgba(109,191,142,0.3)", borderRadius: "10px", padding: "12px 14px", marginBottom: "10px", display: "flex", alignItems: "center", gap: "12px" }}>
          <div style={{ fontSize: "24px" }}>🏆</div>
          <div>
            <div style={{ fontSize: "10px", color: "#4a8a6a", letterSpacing: "2px" }}>MOST VALUABLE PLAYER</div>
            <div style={{ fontSize: "16px", color: GREEN, fontWeight: "bold" }}>{summary.mvp.name}</div>
            <div style={{ fontSize: "11px", color: "#6a9a7a" }}>{summary.mvp.nilMades > 0 ? (summary.mvp.nilMades + " nil" + (summary.mvp.nilMades > 1 ? "s" : "") + " made") : (summary.mvp.bidAccuracy + "% bid accuracy")} · {summary.mvp.teamName}</div>
          </div>
        </div>

        {/* Most bags this game */}
        {summary.mostBagsPlayer.bags > 0 && (
          <div style={{ background: "rgba(232,148,58,0.08)", border: "1px solid rgba(232,148,58,0.25)", borderRadius: "10px", padding: "12px 14px", marginBottom: "10px", display: "flex", alignItems: "center", gap: "12px" }}>
            <div style={{ fontSize: "24px" }}>🎒</div>
            <div>
              <div style={{ fontSize: "10px", color: "#8a5a2a", letterSpacing: "2px" }}>MOST BAGS THIS GAME</div>
              <div style={{ fontSize: "16px", color: ORANGE, fontWeight: "bold" }}>{summary.mostBagsPlayer.name}</div>
              <div style={{ fontSize: "11px", color: "#7a5a3a" }}>{summary.mostBagsPlayer.bags} bag{summary.mostBagsPlayer.bags !== 1 ? "s" : ""} taken</div>
            </div>
          </div>
        )}

        {summary.heavyLifter && (
          <div style={{ background: "rgba(109,191,142,0.08)", border: "1px solid rgba(109,191,142,0.3)", borderRadius: "10px", padding: "12px 14px", marginBottom: "10px", display: "flex", alignItems: "center", gap: "12px" }}>
            <div style={{ fontSize: "24px" }}>💪</div>
            <div>
              <div style={{ fontSize: "10px", color: "#4a8a6a", letterSpacing: "2px" }}>HEAVY LIFTER</div>
              <div style={{ fontSize: "16px", color: GREEN, fontWeight: "bold" }}>{summary.heavyLifter.name}</div>
              <div style={{ fontSize: "11px", color: "#6a9a7a" }}>{summary.heavyLifter.contribution}% of team tricks · carried {summary.heavyLifter.teamName}</div>
            </div>
          </div>
        )}
        {summary.deadWeight && (
          <div style={{ background: "rgba(224,92,92,0.08)", border: "1px solid rgba(224,92,92,0.25)", borderRadius: "10px", padding: "12px 14px", marginBottom: "10px", display: "flex", alignItems: "center", gap: "12px" }}>
            <div style={{ fontSize: "24px" }}>⚓</div>
            <div>
              <div style={{ fontSize: "10px", color: "#8a2a2a", letterSpacing: "2px" }}>DEAD WEIGHT</div>
              <div style={{ fontSize: "16px", color: RED, fontWeight: "bold" }}>{summary.deadWeight.name}</div>
              <div style={{ fontSize: "11px", color: "#8a4a4a" }}>{summary.deadWeight.contribution}% of team tricks · got carried</div>
            </div>
          </div>
        )}

        {summary.nilMaster && (
          <div style={{ background: "rgba(0,191,255,0.07)", border: "1px solid rgba(0,191,255,0.25)", borderRadius: "10px", padding: "12px 14px", marginBottom: "10px", display: "flex", alignItems: "center", gap: "12px" }}>
            <div style={{ fontSize: "24px" }}>🎯</div>
            <div>
              <div style={{ fontSize: "10px", color: "#4a7a9a", letterSpacing: "2px" }}>NIL MASTER</div>
              <div style={{ fontSize: "16px", color: BLUE, fontWeight: "bold" }}>{summary.nilMaster.name}</div>
              <div style={{ fontSize: "11px", color: "#6a8a9a" }}>{summary.nilMaster.blindMade > 0 ? (summary.nilMaster.blindMade + " blind nil" + (summary.nilMaster.blindMade > 1 ? "s" : "") + " nailed") : (summary.nilMaster.nilMade + " nil" + (summary.nilMaster.nilMade > 1 ? "s" : "") + " made")}</div>
            </div>
          </div>
        )}
        {summary.nilBust && (
          <div style={{ background: "rgba(224,92,92,0.07)", border: "1px solid rgba(224,92,92,0.22)", borderRadius: "10px", padding: "12px 14px", marginBottom: "10px", display: "flex", alignItems: "center", gap: "12px" }}>
            <div style={{ fontSize: "24px" }}>💥</div>
            <div>
              <div style={{ fontSize: "10px", color: "#8a2a2a", letterSpacing: "2px" }}>BLEW THE NIL</div>
              <div style={{ fontSize: "16px", color: RED, fontWeight: "bold" }}>{summary.nilBust.name}</div>
              <div style={{ fontSize: "11px", color: "#8a4a4a" }}>{summary.nilBust.blindFailed > 0 ? "blind nil went down in flames" : "couldn't keep it clean"}</div>
            </div>
          </div>
        )}

        <InstallPrompt gameJustEnded={gs.winner !== null} />

        {/* Cross-game sandbaggers */}
        {summary.sandbaggers.length > 0 && (
          <div style={{ background: "rgba(224,92,92,0.08)", border: "1px solid rgba(224,92,92,0.25)", borderRadius: "10px", padding: "12px 14px", marginBottom: "16px", display: "flex", alignItems: "center", gap: "12px" }}>
            <div style={{ fontSize: "24px" }}>⚠️</div>
            <div>
              <div style={{ fontSize: "10px", color: "#8a2a2a", letterSpacing: "2px" }}>CAREER SANDBAGGER{summary.sandbaggers.length > 1 ? "S" : ""}</div>
              <div style={{ fontSize: "14px", color: RED, fontWeight: "bold" }}>{summary.sandbaggers.map(function(p) { return p.name; }).join(", ")}</div>
              <div style={{ fontSize: "11px", color: "#6a3a3a" }}>≥30% overtrick rate across all games</div>
            </div>
          </div>
        )}

        {/* Actions: two clear CTAs (post image / send link) + a quiet utility row */}
        <button onClick={shareRecapImage}
          style={{ width: "100%", background: "linear-gradient(135deg,#c8a84e,#e8c878)", color: DIM, border: "none", borderRadius: "12px", padding: "16px", fontSize: "14px", fontFamily: "Georgia, serif", fontWeight: "bold", letterSpacing: "2px", textTransform: "uppercase", cursor: "pointer", marginBottom: "10px", boxShadow: "0 0 22px rgba(200,168,78,0.28)" }}>
          Share Recap
        </button>

        {gs.shareCode && (
          <button onClick={shareGame}
            style={{ width: "100%", background: "transparent", color: GOLD, border: "1px solid rgba(200,168,78,0.5)", borderRadius: "12px", padding: "14px", fontSize: "12px", fontFamily: "Georgia, serif", fontWeight: "bold", letterSpacing: "2px", textTransform: "uppercase", cursor: "pointer", marginBottom: "14px" }}>
            Send to Players
          </button>
        )}

        <div style={{ display: "flex", justifyContent: "center", gap: "20px", alignItems: "center" }}>
          <button onClick={copyToClipboard} style={{ background: "transparent", border: "none", color: "#7a8a9a", fontSize: "11px", fontFamily: "Georgia, serif", letterSpacing: "1px", cursor: "pointer", textDecoration: "underline" }}>Copy text</button>
          <button onClick={function() { setShowQR(function(v) { return !v; }); }} style={{ background: "transparent", border: "none", color: "#7a8a9a", fontSize: "11px", fontFamily: "Georgia, serif", letterSpacing: "1px", cursor: "pointer", textDecoration: "underline" }}>{showQR ? "Hide QR" : "Get the app"}</button>
          <button onClick={onDismiss} style={{ background: "transparent", border: "none", color: "#7a8a9a", fontSize: "11px", fontFamily: "Georgia, serif", letterSpacing: "1px", cursor: "pointer", textDecoration: "underline" }}>Done</button>
        </div>
        {showQR && <div style={{ textAlign: "center", marginTop: "12px" }}><img src="https://api.qrserver.com/v1/create-qr-code/?size=100x100&data=https://bidtoset.app&color=c8a84e&bgcolor=0a0e1b" alt="QR" style={{ width: "100px", height: "100px", borderRadius: "6px" }} /><div style={{ fontSize: "9px", color: "#6a7a8a", marginTop: "4px" }}>bidtoset.app</div></div>}
        {recapPreview && (
          <div onClick={function() { setRecapPreview(null); }} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.92)", zIndex: 600, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "20px", overflowY: "auto" }}>
            <div style={{ fontSize: "11px", color: "#8aaabb", letterSpacing: "2px", marginBottom: "10px", textTransform: "uppercase" }}>Your shareable recap</div>
            <img src={recapPreview} alt="Game recap" onClick={function(e) { e.stopPropagation(); }} style={{ maxWidth: "min(360px, 88vw)", width: "100%", borderRadius: "12px", border: "1px solid rgba(200,168,78,0.4)" }} />
            <div onClick={function(e) { e.stopPropagation(); }} style={{ display: "flex", gap: "10px", marginTop: "16px" }}>
              <a href={recapPreview} download="bidtoset-recap.png" style={{ background: GOLD, color: "#0a0e1b", textDecoration: "none", fontWeight: "bold", fontSize: "13px", letterSpacing: "1px", padding: "12px 22px", borderRadius: "10px" }}>Save image</a>
              <button onClick={function() { setRecapPreview(null); }} style={{ background: "transparent", color: "#c0d0e0", border: "1px solid rgba(255,255,255,0.2)", borderRadius: "10px", padding: "12px 22px", fontSize: "13px", cursor: "pointer" }}>Close</button>
            </div>
            <div style={{ fontSize: "10px", color: "#6a7a8a", marginTop: "12px", textAlign: "center", maxWidth: "320px" }}>Right-click (or long-press) the image to copy or post it to Instagram, Facebook, or Messages.</div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── History Screen ───────────────────────────────────────────────────────────

function HistoryScreen({ onClose, onReset, rules }) {
  const [history, setHistory] = useState(loadHistory);
  const [selected, setSelected] = useState(null);
  const [sync, setSync] = useState(null);   // {state, msg}

  async function runBackfill() {
    setSync({ state: "run", msg: "Checking the cloud…" });
    const r = await cloudBackfillHistory(rules, function (done, total) {
      setSync({ state: "run", msg: "Uploading " + done + " of " + total + "…" });
    });
    if (!r.ok) { setSync({ state: "err", msg: "Could not sync — " + r.reason }); return; }
    setSync({ state: "ok", msg: r.pushed
      ? ("Uploaded " + r.pushed + " game" + (r.pushed === 1 ? "" : "s") + " · " + r.skipped + " already there")
      : "Everything on this device is already in the cloud" });
  }

  function clearHistory() {
    if (window.confirm("Clear all game history? This cannot be undone.")) {
      localStorage.removeItem(HISTORY_KEY);
      setHistory([]);
    }
  }

  // Delete ONE game. Clearing everything was the only option before, which meant
  // a couple of junk test games could only be removed by throwing away every real
  // game with them.
  function deleteGame(id, label) {
    if (!window.confirm("Delete this game?\n\n" + label + "\n\nThis cannot be undone.")) return;
    const next = history.filter(function (g) { return g.id !== id; });
    setHistory(next);
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(next)); } catch (_) {}
    if (selected === id) setSelected(null);
  }

  function SyncRow() {
    return (
      <div style={{ marginBottom: "16px" }}>
        <button onClick={runBackfill} disabled={sync && sync.state === "run"}
          style={{ width: "100%", background: "rgba(0,229,255,0.08)", border: "1px solid rgba(0,229,255,0.3)", borderRadius: "10px",
                   padding: "12px", fontSize: "12px", fontFamily: "Georgia, serif", color: "#00e5ff",
                   letterSpacing: "1px", cursor: (sync && sync.state === "run") ? "wait" : "pointer" }}>
          {(sync && sync.state === "run") ? sync.msg : "\u2601 Sync this device's games to the cloud"}
        </button>
        {sync && sync.state !== "run" && (
          <div style={{ fontSize: "11px", marginTop: "6px", textAlign: "center",
                        color: sync.state === "err" ? ORANGE : "#7ac77a" }}>{sync.msg}</div>
        )}
        <div style={{ fontSize: "9px", color: "#5a6a7a", marginTop: "6px", textAlign: "center", fontStyle: "italic" }}>
          Games this phone recorded before cloud sync existed only live here. Uploading adds them to career stats. Already-synced games are skipped.
        </div>
      </div>
    );
  }

  if (selected) {
    const game = history.find(function(g) { return g.id === selected; });
    return (
      <div style={{ position: "fixed", inset: 0, background: BG, zIndex: 200, overflowY: "auto", padding: "16px" }}>
        <div style={{ maxWidth: "520px", margin: "0 auto" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "16px" }}>
            <button onClick={function() { setSelected(null); }} style={{ background: "transparent", border: "1px solid rgba(255,255,255,0.2)", borderRadius: "8px", padding: "8px 14px", color: "#c0d0e0", cursor: "pointer", fontFamily: "Georgia, serif", fontSize: "12px" }}>Back</button>
            <div style={{ color: GOLD, fontSize: "14px", fontVariant: "small-caps" }}>{game.date} at {game.time}</div>
          </div>

          <div style={{ display: "flex", gap: "10px", marginBottom: "16px" }}>
            {game.teams.map(function(t, i) {
              return (
                <div key={i} style={{ flex: 1, background: "rgba(255,255,255,0.04)", border: "1px solid " + (i === 0 ? "#2d5a40" : "#5a2d2d"), borderRadius: "10px", padding: "12px", textAlign: "center" }}>
                  <div style={{ fontSize: "11px", color: GOLD, fontWeight: "bold" }}>{t.name}</div>
                  <div style={{ fontSize: "9px", color: "#6a7a8a" }}>{t.p[0]} / {t.p[1]}</div>
                  <div style={{ fontSize: "36px", fontWeight: "bold", color: t.score >= 0 ? GOLD : RED }}>{t.score}</div>
                  {game.winner === t.name && <div style={{ fontSize: "11px", color: GREEN, marginTop: "4px" }}>WINNER</div>}
                </div>
              );
            })}
          </div>

          {game.rounds && game.rounds.map(function(r, idx) {
            return (
              <div key={idx} style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)", borderRadius: "10px", padding: "12px", marginBottom: "8px" }}>
                <div style={{ fontSize: "10px", color: "#a0b8c8", letterSpacing: "2px", marginBottom: "8px", textAlign: "center" }}>ROUND {r.num}</div>
                <div style={{ display: "flex", gap: "8px" }}>
                  {game.teams.map(function(team, i) {
                    const snap = r.snap || game.teams;
                    const nm = snap[i] || team;
                    const re = r.entry[i];
                    const p1n = re.p1nil, p2n = re.p2nil;
                    const wasSet = r.results[i].wasSet;
                    return (
                      <div key={i} style={{ flex: 1, textAlign: "center", fontSize: "11px", background: wasSet ? "rgba(232,148,58,0.07)" : "rgba(255,255,255,0.02)", border: "1px solid " + (wasSet ? "rgba(232,148,58,0.15)" : "rgba(255,255,255,0.04)"), borderRadius: "8px", padding: "8px" }}>
                        <div style={{ color: wasSet ? ORANGE : GOLD, marginBottom: "4px", fontWeight: "bold" }}>{nm.name || nm}{wasSet ? " (SET)" : ""}</div>
                        <div style={{ color: p1n === 2 ? BLUE : p1n === 1 ? GOLD : "#b0c4d8", fontSize: "10px" }}>{nm.p ? nm.p[0] : team.p[0]}: {p1n === 2 ? "Blind Nil" : p1n === 1 ? "Nil" : "bid " + re.p1bid} - {re.p1tricks} tricks{(p1n > 0 && parseInt(re.p1tricks) > 0) ? " ❌ NIL FAILED" : ""}</div>
                        <div style={{ color: p2n === 2 ? BLUE : p2n === 1 ? GOLD : "#b0c4d8", fontSize: "10px" }}>{nm.p ? nm.p[1] : team.p[1]}: {p2n === 2 ? "Blind Nil" : p2n === 1 ? "Nil" : "bid " + re.p2bid} - {re.p2tricks} tricks{(p2n > 0 && parseInt(re.p2tricks) > 0) ? " ❌ NIL FAILED" : ""}</div>
                        <div style={{ color: r.results[i].pts >= 0 ? GREEN : RED, fontWeight: "bold", fontSize: "13px", marginTop: "4px" }}>{r.results[i].pts >= 0 ? "+" : ""}{r.results[i].pts} pts</div>
                        {(parseInt(r.entry[i].p1bid || 0) + parseInt(r.entry[i].p2bid || 0) === 13 && r.results[i].pts > 0) && <div style={{ fontSize: "10px", color: "#00bfff", fontWeight: "bold", marginTop: "3px", textShadow: "0 0 8px rgba(0,191,255,0.6)" }}>BOSTON</div>}
                        {r.results[i].bags === 0 && r.results[i].pts > 0 && !r.results[i].wasSet && <div style={{ fontSize: "9px", color: "#c8a84e", fontStyle: "italic", marginTop: "2px", textShadow: "0 0 6px rgba(200,168,78,0.4)" }}>Clean Hand</div>}
                        {((parseInt(r.entry[i].p1bid||0) >= 5 && parseInt(r.entry[i].p1tricks||0) === 0) || (parseInt(r.entry[i].p2bid||0) >= 5 && parseInt(r.entry[i].p2tricks||0) === 0)) && <RenegadeIcon />}
                        {r.penalties && r.penalties[i] !== 0 && <div style={{ color: RED, fontSize: "10px", fontWeight: "bold" }}>BAG PENALTY {r.penalties[i]}{r.bagsRaw && r.bagsAfter ? " \u00b7 " + r.bagsRaw[i] + " bags \u2192 " + r.bagsAfter[i] : ""}</div>}
                        <div style={{ color: "#d0e0f0", fontSize: "10px" }}>Score: {r.after[i]}</div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: BG, zIndex: 200, overflowY: "auto", padding: "16px" }}>
      <div style={{ maxWidth: "520px", margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "20px" }}>
          <button onClick={onClose} style={{ background: "transparent", border: "1px solid rgba(255,255,255,0.2)", borderRadius: "8px", padding: "8px 14px", color: "#c0d0e0", cursor: "pointer", fontFamily: "Georgia, serif", fontSize: "12px" }}>Close</button>
          <div style={{ fontSize: "20px", color: GOLD, fontVariant: "small-caps", letterSpacing: "3px" }}>Game History</div>
          <div style={{ display: "flex", gap: "8px" }}>
            {onReset && <button onClick={onReset} style={{ background: "rgba(200,168,78,0.12)", border: "1px solid rgba(200,168,78,0.4)", borderRadius: "8px", padding: "8px 14px", color: GOLD, cursor: "pointer", fontFamily: "Georgia, serif", fontSize: "10px", fontWeight: "bold" }}>New Game</button>}
            <button onClick={clearHistory} style={{ background: "transparent", border: "1px solid rgba(224,92,92,0.3)", borderRadius: "8px", padding: "8px 14px", color: RED, cursor: "pointer", fontFamily: "Georgia, serif", fontSize: "10px" }}>Clear All</button>
          </div>
        </div>

        <SyncRow />

        {history.length === 0 ? (
          <div style={{ textAlign: "center", padding: "60px 20px" }}>
            <div style={{ fontSize: "100px", marginBottom: "20px", lineHeight: 1, color: GOLD, textShadow: "0 0 30px rgba(200,168,78,0.5)" }}>♠</div>
            <div style={{ fontSize: "20px", color: "#c0d0e0", fontWeight: "bold", letterSpacing: "1px" }}>No games saved yet.</div>
            <div style={{ fontSize: "13px", marginTop: "12px", color: "#a0b0c0" }}>Complete a game to see it here.</div>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
            {history.map(function(game) {
              return (
                <div key={game.id} onClick={function() { setSelected(game.id); }}
                  style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(200,168,78,0.15)", borderRadius: "12px", padding: "14px", cursor: "pointer", position: "relative" }}>
                  <button
                    onClick={function (ev) {
                      ev.stopPropagation();
                      const nm = (game.teams && game.teams.length === 2)
                        ? (game.teams[0].name + " vs " + game.teams[1].name)
                        : "this game";
                      deleteGame(game.id, nm + "  ·  " + game.date);
                    }}
                    title="Delete this game"
                    style={{ position: "absolute", top: "8px", right: "8px", background: "rgba(220,60,60,0.12)", color: "#e08080",
                             border: "1px solid rgba(220,60,60,0.35)", borderRadius: "8px", width: "30px", height: "30px",
                             fontSize: "15px", lineHeight: 1, cursor: "pointer", padding: 0, zIndex: 2 }}>
                    &times;
                  </button>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px", paddingRight: "34px" }}>
                    <div style={{ fontSize: "11px", color: "#6a7a8a" }}>{game.date} at {game.time}</div>
                    <div style={{ fontSize: "10px", color: "#4a5a6a" }}>{game.totalRounds} rounds</div>
                  </div>
                  <div style={{ display: "flex", gap: "10px" }}>
                    {game.teams.map(function(t, i) {
                      return (
                        <div key={i} style={{ flex: 1, textAlign: "center" }}>
                          <div style={{ fontSize: "11px", color: game.winner === t.name ? GREEN : GOLD, fontWeight: "bold" }}>{t.name} {game.winner === t.name ? "W" : ""}</div>
                          <div style={{ fontSize: "9px", color: "#5a6a7a" }}>{t.p[0]} / {t.p[1]}</div>
                          <div style={{ fontSize: "24px", fontWeight: "bold", color: t.score >= 0 ? GOLD : RED }}>{t.score}</div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Stats Screen ─────────────────────────────────────────────────────────────

// ─── Career stats, straight from the database ────────────────────────────────
// The cloud has every game every phone at the table has ever scored, with the
// per-device aliases already resolved to one person. localStorage only ever had
// this device's slice, which is why six phones showed six different histories.
function CareerStats() {
  const [rows, setRows] = React.useState(null);
  const [pairs, setPairs] = React.useState([]);
  const [err, setErr] = React.useState(null);

  React.useEffect(function () {
    var alive = true;
    (async function () {
      try {
        const a = await supabase.from("v_person_career")
          .select("player,games,wins,win_pct,hands,avg_bid,exact_pct,bags,bags_per_hand,nils,nils_made,nil_pct")
          .order("hands", { ascending: false });
        if (!alive) return;
        if (a.error) { setErr(a.error.message || "could not load"); return; }
        setRows((a.data || []).filter(function (r) { return (r.hands || 0) > 0; }));
        const b = await supabase.from("v_partnerships")
          .select("partnership,games,wins,win_pct").order("games", { ascending: false });
        if (alive && !b.error) setPairs(b.data || []);
      } catch (e) { if (alive) setErr("offline"); }
    })();
    return function () { alive = false; };
  }, []);

  if (err) return (
    <div style={{ background: "rgba(232,148,58,0.08)", border: "1px solid rgba(232,148,58,0.25)", borderRadius: "10px", padding: "14px", fontSize: "12px", color: ORANGE }}>
      Career stats need a connection — {err}. This device's own history is still below.
    </div>
  );
  if (rows === null) return (
    <div style={{ textAlign: "center", padding: "24px", color: "#6a7a8a", fontSize: "12px" }}>Loading career stats…</div>
  );
  if (!rows.length) return null;

  function Th(props) { return <th style={{ textAlign: props.a || "right", fontSize: "9px", color: "#7a9ab8", letterSpacing: "1px", fontWeight: "normal", padding: "0 4px 6px" }}>{props.children}</th>; }
  function Td(props) { return <td style={{ textAlign: props.a || "right", fontSize: "12px", color: props.c || "#c0d0e0", padding: "7px 4px", borderTop: "1px solid rgba(255,255,255,0.05)", fontWeight: props.b ? "bold" : "normal" }}>{props.children}</td>; }

  return (
    <div style={{ marginBottom: "22px" }}>
      <div style={{ fontSize: "11px", color: GOLD, letterSpacing: "2px", textTransform: "uppercase", marginBottom: "10px" }}>
        Career · every phone, every game
      </div>
      <div style={{ overflowX: "auto", background: "rgba(255,255,255,0.02)", border: "1px solid rgba(200,168,78,0.15)", borderRadius: "12px", padding: "12px" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr>
            <Th a="left">PLAYER</Th><Th>GP</Th><Th>W</Th><Th>WIN%</Th><Th>HANDS</Th><Th>EXACT%</Th><Th>BAGS/H</Th><Th>NIL</Th>
          </tr></thead>
          <tbody>
            {rows.map(function (r) {
              return (
                <tr key={r.player}>
                  <Td a="left" b={true} c="#e8dcc8">{r.player}</Td>
                  <Td>{r.games}</Td>
                  <Td>{r.wins}</Td>
                  <Td c={r.win_pct >= 50 ? "#7ac77a" : "#c0d0e0"}>{r.win_pct === null ? "—" : r.win_pct + "%"}</Td>
                  <Td>{r.hands}</Td>
                  <Td c={GOLD} b={true}>{r.exact_pct === null ? "—" : r.exact_pct + "%"}</Td>
                  <Td c={r.bags_per_hand >= 0.8 ? ORANGE : "#c0d0e0"}>{r.bags_per_hand === null ? "—" : r.bags_per_hand}</Td>
                  <Td>{r.nils ? (r.nils_made + "/" + r.nils) : "—"}</Td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div style={{ fontSize: "9px", color: "#5a6a7a", marginTop: "8px", fontStyle: "italic" }}>
          EXACT% = hit the bid on the nose. BAGS/H = bags per biddable hand — lower is better.
        </div>
      </div>

      {pairs.length > 0 && (
        <div style={{ marginTop: "14px", background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "12px", padding: "12px" }}>
          <div style={{ fontSize: "10px", color: "#7a9ab8", letterSpacing: "2px", marginBottom: "8px" }}>PARTNERSHIPS</div>
          {pairs.map(function (p) {
            return (
              <div key={p.partnership} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
                <div style={{ fontSize: "12px", color: "#c8d8e8" }}>{p.partnership}</div>
                <div style={{ fontSize: "12px", color: p.win_pct >= 50 ? "#7ac77a" : "#a8bccc" }}>
                  {p.wins}-{p.games - p.wins} <span style={{ color: "#6a7a8a" }}>· {p.win_pct}%</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function StatsScreen({ onClose }) {
  const history = loadHistory();
  const players = buildPlayerStats(history);

  function StatBar({ label, value, color, suffix }) {
    return (
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
        <div style={{ fontSize: "11px", color: "#8a9aaa" }}>{label}</div>
        <div style={{ fontSize: "13px", fontWeight: "bold", color: color || "#c0d0e0" }}>{value}{suffix || ""}</div>
      </div>
    );
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: BG, zIndex: 200, overflowY: "auto", padding: "16px" }}>
      <div style={{ maxWidth: "520px", margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "20px" }}>
          <button onClick={onClose} style={{ background: "transparent", border: "1px solid rgba(255,255,255,0.2)", borderRadius: "8px", padding: "8px 14px", color: "#c0d0e0", cursor: "pointer", fontFamily: "Georgia, serif", fontSize: "12px" }}>Close</button>
          <div style={{ fontSize: "20px", color: GOLD, fontVariant: "small-caps", letterSpacing: "3px" }}>Player Stats</div>
          <div style={{ width: "60px" }} />
        </div>

        <CareerStats />

        {players.length > 0 && (
          <div style={{ fontSize: "11px", color: "#7a9ab8", letterSpacing: "2px", textTransform: "uppercase", marginBottom: "10px" }}>
            This device only
          </div>
        )}

        {players.length === 0 ? (
          <div style={{ textAlign: "center", color: "#4a5a6a", padding: "60px 20px" }}>
            <div style={{ fontSize: "40px", marginBottom: "16px" }}>♠</div>
            <div style={{ fontSize: "14px", color: "#c0d0e0" }}>No player data yet.</div>
            <div style={{ fontSize: "12px", marginTop: "8px", color: "#8a9aaa" }}>Complete games to build player profiles.</div>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
            {players.map(function(p) {
              return (
                <div key={p.name} style={{ background: "rgba(255,255,255,0.03)", border: "1px solid " + (p.isSandbagger ? "rgba(232,148,58,0.4)" : "rgba(200,168,78,0.15)"), borderRadius: "12px", padding: "14px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
                    <div style={{ fontSize: "16px", color: GOLD, fontWeight: "bold" }}>{isRedditName(p.name) ? "👽 " : ""}{p.name}</div>
                    <div style={{ display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
                      {p.isHeavyLifter && <div style={{ fontSize: "10px", padding: "3px 8px", borderRadius: "4px", background: "rgba(109,191,142,0.2)", color: GREEN, fontWeight: "bold", letterSpacing: "1px" }}>HEAVY LIFTER</div>}
                      {p.isDeadWeight && <div style={{ fontSize: "10px", padding: "3px 8px", borderRadius: "4px", background: "rgba(224,92,92,0.2)", color: RED, fontWeight: "bold", letterSpacing: "1px" }}>DEAD WEIGHT</div>}
                      {p.isSandbagger && <SandbaggerBadge player={p} />}
                      <div style={{ fontSize: "11px", color: "#4a5a6a" }}>{p.games} game{p.games !== 1 ? "s" : ""}</div>
                    </div>
                  </div>

                  <div style={{ marginBottom: "10px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "4px" }}>
                      <div style={{ fontSize: "10px", color: "#6a7a8a" }}>Win Rate</div>
                      <div style={{ fontSize: "10px", color: p.winRate >= 50 ? GREEN : RED, fontWeight: "bold" }}>{p.winRate}%</div>
                    </div>
                    <div style={{ height: "4px", background: "rgba(255,255,255,0.08)", borderRadius: "2px" }}>
                      <div style={{ height: "100%", width: p.winRate + "%", background: p.winRate >= 50 ? GREEN : RED, borderRadius: "2px", transition: "width 0.5s" }} />
                    </div>
                  </div>

                  <StatBar label="Bid Accuracy" value={p.bidAccuracy} suffix="%" color={p.bidAccuracy >= 60 ? GREEN : p.bidAccuracy >= 40 ? GOLD : RED} />
                  <StatBar label="Sandbag Rate" value={p.sandbagRate} suffix="%" color={p.sandbagRate >= 30 ? ORANGE : p.sandbagRate >= 15 ? GOLD : GREEN} />
                  <StatBar label="Avg Bags/Round" value={p.avgBagsPerRound} color={parseFloat(p.avgBagsPerRound) >= 1 ? ORANGE : GREEN} />
                  <StatBar label="Set Rate" value={p.rounds > 0 ? Math.round((p.sets / p.rounds) * 100) : 0} suffix="%" color={p.sets > 0 ? RED : GREEN} />

                  {p.deadWeightIndex !== null && (
                    <div style={{ marginTop: "6px" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "4px" }}>
                        <div style={{ fontSize: "10px", color: "#6a7a8a" }}>Dead Weight Index</div>
                        <div style={{ fontSize: "10px", fontWeight: "bold", color: p.isDeadWeight ? RED : p.isHeavyLifter ? GREEN : GOLD }}>{p.deadWeightIndex}% of team tricks</div>
                      </div>
                      <div style={{ height: "6px", background: "rgba(255,255,255,0.08)", borderRadius: "3px", position: "relative" }}>
                        <div style={{ position: "absolute", left: "40%", top: 0, bottom: 0, width: "1px", background: "rgba(255,255,255,0.2)" }} />
                        <div style={{ position: "absolute", left: "60%", top: 0, bottom: 0, width: "1px", background: "rgba(255,255,255,0.2)" }} />
                        <div style={{ height: "100%", width: p.deadWeightIndex + "%", background: p.isDeadWeight ? RED : p.isHeavyLifter ? GREEN : GOLD, borderRadius: "3px", transition: "width 0.5s" }} />
                      </div>
                      <div style={{ display: "flex", justifyContent: "space-between", marginTop: "2px" }}>
                        <div style={{ fontSize: "8px", color: "#3a4a5a" }}>Dead Weight</div>
                        <div style={{ fontSize: "8px", color: "#3a4a5a" }}>Even</div>
                        <div style={{ fontSize: "8px", color: "#3a4a5a" }}>Heavy Lifter</div>
                      </div>
                      <div style={{ fontSize: "8px", color: "#5a6a7a", textAlign: "center", marginTop: "4px", fontStyle: "italic" }}>% of team tricks taken. 50% = even split with partner.</div>
                    </div>
                  )}

                  {p.nilAttempts > 0 && <StatBar label={"Nil (" + p.nilAttempts + " attempts)"} value={p.nilRate} suffix="% success" color={p.nilRate >= 70 ? GREEN : p.nilRate >= 40 ? GOLD : RED} />}
                  {p.blindNilAttempts > 0 && <StatBar label={"Blind Nil (" + p.blindNilAttempts + " attempts)"} value={p.blindNilRate} suffix="% success" color={p.blindNilRate >= 50 ? BLUE : RED} />}

                  {p.isSandbagger && (
                    <div style={{ marginTop: "10px", background: "rgba(232,148,58,0.1)", border: "1px solid rgba(232,148,58,0.3)", borderRadius: "8px", padding: "8px 10px", fontSize: "11px", color: ORANGE, textAlign: "center" }}>
                      Sandbagged {p.overBid} of {p.madeBid + p.overBid + p.underBid} rounds - consistently underbidding
                    </div>
                  )}
                  {p.isDeadWeight && (
                    <div style={{ marginTop: "8px", background: "rgba(224,92,92,0.1)", border: "1px solid rgba(224,92,92,0.3)", borderRadius: "8px", padding: "8px 10px", fontSize: "11px", color: RED, textAlign: "center" }}>
                      Dead Weight - only taking {p.deadWeightIndex}% of team tricks
                    </div>
                  )}
                  {p.isHeavyLifter && (
                    <div style={{ marginTop: "8px", background: "rgba(109,191,142,0.1)", border: "1px solid rgba(109,191,142,0.3)", borderRadius: "8px", padding: "8px 10px", fontSize: "11px", color: GREEN, textAlign: "center" }}>
                      Heavy Lifter - taking {p.deadWeightIndex}% of team tricks
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Settings Screen ──────────────────────────────────────────────────────────

function SettingsScreen({ onClose, settings, onSave, gameStarted, onShowInstructions }) {
  const [draft, setDraft] = React.useState(Object.assign({}, settings));
  const [showQR, setShowQR] = React.useState(false);

  // `live` marks a setting that does NOT affect scoring, so it stays editable
  // while a game is running. The rules lock exists to stop the maths changing
  // mid-game; the bid clock is pacing, not maths.
  function Option({ label, field, options, live, note }) {
    const locked = gameStarted && !live;
    return (
      <div style={{ marginBottom: "16px" }}>
        <div style={{ fontSize: "11px", color: "#8aaabb", letterSpacing: "2px", textTransform: "uppercase", marginBottom: "8px" }}>
          {label}{live && gameStarted ? <span style={{ color: "#5a8a6a", letterSpacing: "1px" }}> · changeable now</span> : null}
        </div>
        <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
          {options.map(function(opt) {
            const active = draft[field] === opt.value;
            return (
              <button key={opt.value} onClick={function() {
                  if (locked) return;
                  const nd = Object.assign({}, draft, { [field]: opt.value });
                  setDraft(nd);
                  // A live setting applies the moment it is tapped - no Save needed,
                  // because Save is hidden once a game is under way.
                  if (live && gameStarted) { onSave(nd); saveSettings(nd); }
                }}
                style={{ flex: 1, minWidth: "60px", padding: "10px 6px", borderRadius: "8px", fontFamily: "Georgia, serif", fontSize: "12px", cursor: locked ? "not-allowed" : "pointer", fontWeight: active ? "bold" : "normal",
                  background: active ? "rgba(200,168,78,0.2)" : "rgba(255,255,255,0.04)",
                  border: "1px solid " + (active ? GOLD : "rgba(255,255,255,0.12)"),
                  color: active ? GOLD : locked ? "#3a4a5a" : "#c0d0e0",
                  opacity: locked && !active ? 0.4 : 1,
                }}>
                {opt.label}
              </button>
            );
          })}
        </div>
        {note && <div style={{ fontSize: "10px", color: "#6a8a9a", marginTop: "6px", fontStyle: "italic" }}>{note}</div>}
      </div>
    );
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: BG, zIndex: 200, overflowY: "auto", padding: "16px" }}>
      <div style={{ maxWidth: "520px", margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "24px" }}>
          <button onClick={onClose} style={{ background: "transparent", border: "1px solid rgba(255,255,255,0.2)", borderRadius: "8px", padding: "8px 14px", color: "#c0d0e0", cursor: "pointer", fontFamily: "Georgia, serif", fontSize: "12px" }}>Close</button>
          <div style={{ fontSize: "20px", color: GOLD, fontVariant: "small-caps", letterSpacing: "3px" }}>House Rules</div>
          <div style={{ width: "60px" }} />
        </div>

        {gameStarted && (
          <div style={{ background: "rgba(232,148,58,0.1)", border: "1px solid rgba(232,148,58,0.3)", borderRadius: "10px", padding: "12px", marginBottom: "20px", textAlign: "center", fontSize: "11px", color: ORANGE }}>
            Rules locked — game in progress. Reset to change rules.
          </div>
        )}

        <Option label="Win Score" field="winScore" options={[
          { label: "250", value: 250 }, { label: "300", value: 300 },
          { label: "350", value: 350 }, { label: "400", value: 400 },
          { label: "500", value: 500 },
        ]} />
        <Option label="Lose Score" field="loseScore" options={[
          { label: "None", value: 0 }, { label: "-100", value: -100 }, { label: "-150", value: -150 },
          { label: "-200", value: -200 }, { label: "-300", value: -300 },
        ]} />
        <Option label="Bag Limit" field="bagLimit" options={[
          { label: "5 bags", value: 5 }, { label: "7 bags", value: 7 },
          { label: "10 bags", value: 10 },
        ]} />
        <Option label="Bag Penalty" field="bagPenalty" options={[
          { label: "-50 pts", value: -50 }, { label: "-100 pts", value: -100 },
          { label: "-150 pts", value: -150 },
        ]} />
        <Option label="Min Team Bid" field="minBid" options={[
          { label: "1 (off)", value: 1 }, { label: "2 (default)", value: 2 },
          { label: "3", value: 3 }, { label: "4", value: 4 },
        ]} />
        <Option label="Bid Clock" field="bidSeconds" live={true}
          note="Resets on any bid activity. Off hides the clock and the buzzer entirely."
          options={[
          { label: "Off", value: 0 }, { label: "15s", value: 15 },
          { label: "20s", value: 20 }, { label: "25s", value: 25 },
        ]} />

        {!gameStarted && (
          <button onClick={function() { onSave(draft); saveSettings(draft); onClose(); }}
            style={{ width: "100%", background: GOLD, color: DIM, border: "none", borderRadius: "10px", padding: "16px", fontSize: "14px", fontFamily: "Georgia, serif", fontWeight: "bold", letterSpacing: "2px", textTransform: "uppercase", cursor: "pointer", marginTop: "8px" }}>
            Save Rules
          </button>
        )}

        <div style={{ marginTop: "20px", background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: "10px", padding: "14px" }}>
          <div style={{ fontSize: "10px", color: "#6a7a8a", letterSpacing: "2px", marginBottom: "10px" }}>CURRENT RULES</div>
          {[
            ["Win at", draft.winScore + " pts"],
            ["Lose at", draft.loseScore === 0 ? "None" : draft.loseScore + " pts"],
            ["Bag limit", draft.bagLimit + " bags → " + draft.bagPenalty + " pts"],
            ["Min bid", draft.minBid === 1 ? "No minimum" : draft.minBid + " per team"],
          ].map(function(row) {
            return (
              <div key={row[0]} style={{ display: "flex", justifyContent: "space-between", padding: "5px 0", borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
                <div style={{ fontSize: "11px", color: "#8a9aaa" }}>{row[0]}</div>
                <div style={{ fontSize: "11px", color: GOLD, fontWeight: "bold" }}>{row[1]}</div>
              </div>
            );
          })}
        </div>

        {/* Tip Jar */}
        <div style={{ marginTop: "24px", background: "linear-gradient(135deg, rgba(200,168,78,0.08), rgba(200,168,78,0.15))", border: "1px solid rgba(200,168,78,0.3)", borderRadius: "12px", padding: "16px", textAlign: "center" }}>
          <div style={{ fontSize: "24px", marginBottom: "6px" }}>☕</div>
          <div style={{ fontSize: "14px", color: GOLD, fontWeight: "bold", fontFamily: "Georgia, serif", marginBottom: "6px" }}>Buy Us a Round</div>
          <div style={{ fontSize: "11px", color: "#8a9aaa", marginBottom: "14px", lineHeight: 1.6 }}>BidToSet is free forever. If it saved an argument at your table — we'll take a round. ♠</div>
          <button onClick={function() { window.open("https://ko-fi.com/bidtoset", "_blank"); }}
            style={{ background: GOLD, color: DIM, border: "none", borderRadius: "10px", padding: "12px 28px", fontSize: "13px", fontFamily: "Georgia, serif", fontWeight: "bold", letterSpacing: "2px", textTransform: "uppercase", cursor: "pointer", boxShadow: "0 0 20px rgba(200,168,78,0.3)" }}>
            Tip the Dev ♠
          </button>
        </div>

        <div style={{ marginTop: "16px", textAlign: "center" }}><button onClick={function() { setShowQR(function(v) { return !v; }); }} style={{ background: "transparent", border: "1px solid rgba(200,168,78,0.3)", borderRadius: "10px", padding: "10px 20px", fontSize: "11px", color: GOLD, cursor: "pointer", fontFamily: "Georgia, serif", letterSpacing: "1px" }}>{showQR ? "Hide QR" : "Share BidToSet"}</button>{showQR && <div style={{ marginTop: "12px" }}><img src="https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=https://bidtoset.app&color=c8a84e&bgcolor=0a0e1b" alt="QR" style={{ width: "150px", height: "150px", borderRadius: "8px", border: "2px solid rgba(200,168,78,0.4)" }} /><div style={{ fontSize: "10px", color: "#6a7a8a", marginTop: "6px" }}>bidtoset.app</div></div>}</div>
        {/* Show Instructions toggle */}
        <button onClick={function() {
          try { localStorage.removeItem("bidtoset_onboarded_v1"); } catch(_) {}
          try { localStorage.setItem("bidtoset_show_instructions", "1"); } catch(_) {} onClose();
        }} style={{ marginTop: "16px", width: "100%", background: "transparent", color: "#6a7a8a", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "8px", padding: "10px", fontSize: "10px", fontFamily: "Georgia, serif", letterSpacing: "2px", textTransform: "uppercase", cursor: "pointer" }}>
          Show Instructions
        </button>

      </div>
    </div>
  );
}

// ─── Onboarding Carousel ──────────────────────────────────────────────────────

const ONBOARDING_KEY = "bidtoset_onboarded_v1";

function hasOnboarded() {
  try { return localStorage.getItem(ONBOARDING_KEY) === "true"; } catch (_) { return false; }
}

function markOnboarded() {
  try { localStorage.setItem(ONBOARDING_KEY, "true"); } catch (_) {}
}

const ONBOARDING_CARDS = [
  {
    icon: "♠",
    iconColor: "#c8a84e",
    title: "Welcome to BidToSet",
    subtitle: "Spades Scorekeeper",
    body: "The only scorekeeper that catches mistakes before you score them. Swipe to learn the basics.",
    accent: "#c8a84e",
  },
  {
    icon: "🃏",
    iconColor: "#c8a84e",
    title: "Bidding & NIL",
    subtitle: "Know your bets",
    body: "Each player bids how many tricks they'll take.\n\nNIL = bid zero tricks → +100 if successful, -100 if you take any.\n\nBLIND NIL = bid before seeing your cards → +200 / -200.\n\nTap NIL once for NIL. Double tap for BLIND NIL.",
    accent: "#00bfff",
    highlight: "Double tap NIL button for BLIND NIL",
    highlightColor: "#00bfff",
  },
  {
    icon: "⚠️",
    iconColor: "#e8943a",
    title: "SET & Bags",
    subtitle: "The stakes",
    body: "If your team takes fewer tricks than you bid — you're SET. Lose your bid × 10 points.\n\nExtra tricks = bags. Collect 10 bags and take a -100 point penalty.",
    accent: "#e8943a",
    highlight: "SET = took less than you bid",
    highlightColor: "#e8943a",
  },
  {
    icon: "✏️",
    iconColor: "#6dbf8e",
    title: "Quick Tips",
    subtitle: "Get the most out of BidToSet",
    body: "Tap any name to edit it inline.\n\nIn the Team Name field, type \"Jay and Debbie\" — the app automatically splits into two player names.\n\nSet House Rules before the game starts — they lock after the first round.\n\nApp updates automatically from your home screen.",
    accent: "#6dbf8e",
    highlight: "Team Name field: type \"Name and Name\" to auto-fill",
    highlightColor: "#6dbf8e",
  },
  {
    icon: null, // Special card — renders summary preview instead
    accent: "#c8a84e",
    title: "SUMMARY_PREVIEW", // Flag for special rendering
  },
];

function OnboardingOverlay({ onDismiss }) {
  const [card, setCard] = useState(0);
  const [animDir, setAnimDir] = useState(null);
  const [visible, setVisible] = useState(true);
  const touchStart = useRef(null);

  function goTo(idx, dir) {
    setAnimDir(dir);
    setTimeout(function() {
      setCard(idx);
      setAnimDir(null);
    }, 200);
  }

  function next() {
    if (card < ONBOARDING_CARDS.length - 1) goTo(card + 1, "left");
    else dismiss();
  }

  function prev() {
    if (card > 0) goTo(card - 1, "right");
  }

  function dismiss() {
    setVisible(false);
    markOnboarded();
    setTimeout(onDismiss, 300);
  }

  function onTouchStart(e) {
    touchStart.current = e.touches[0].clientX;
  }

  function onTouchEnd(e) {
    if (touchStart.current === null) return;
    const diff = touchStart.current - e.changedTouches[0].clientX;
    if (Math.abs(diff) > 50) {
      if (diff > 0) next();
      else prev();
    }
    touchStart.current = null;
  }

  const c = ONBOARDING_CARDS[card];
  const isLast = card === ONBOARDING_CARDS.length - 1;
  const isSummaryPreview = c.title === "SUMMARY_PREVIEW";

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 400,
      background: "rgba(0,0,0,0.92)",
      backdropFilter: "blur(12px)",
      display: "flex", alignItems: "flex-start", justifyContent: "center",
      padding: "40px 20px 80px 20px",
      opacity: visible ? 1 : 0,
      transition: "opacity 0.3s ease",
    }}>
      <div
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
        style={{
          width: "100%", maxWidth: "380px",
          background: "linear-gradient(145deg, #0d1528, #090d1b)",
          border: "1px solid " + c.accent,
          borderRadius: "20px",
          padding: isSummaryPreview ? "20px 20px 20px" : "32px 24px 24px",
          boxShadow: "0 0 60px " + c.accent + "40",
          opacity: animDir ? 0 : 1,
          transform: animDir === "left" ? "translateX(-30px)" : animDir === "right" ? "translateX(30px)" : "translateX(0)",
          transition: "opacity 0.2s ease, transform 0.2s ease",
          display: "flex", flexDirection: "column", gap: isSummaryPreview ? "10px" : "16px",
        }}>

        {isSummaryPreview ? (
          // ─── Summary Card Preview ───────────────────────────────────────
          <>
            {/* Header */}
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: "11px", color: GOLD, letterSpacing: "4px", marginBottom: "2px", fontWeight: "bold" }}>AFTER THE GAME</div>
              <div style={{ fontSize: "22px", color: GOLD, fontVariant: "small-caps", letterSpacing: "2px", fontFamily: "Georgia, serif", textShadow: "0 0 20px rgba(200,168,78,0.6)" }}>♠ Game Summary</div>
              <div style={{ fontSize: "11px", color: "#a0b0c0", marginTop: "4px", fontStyle: "italic" }}>Fuel for table talk. Proof for bragging rights.</div>
            </div>

            {/* Winner block */}
            <div style={{ background: "linear-gradient(135deg, rgba(200,168,78,0.2), rgba(200,168,78,0.35))", border: "2px solid " + GOLD, borderRadius: "12px", padding: "12px", textAlign: "center", boxShadow: "0 0 20px rgba(200,168,78,0.3)" }}>
              <div style={{ fontSize: "10px", color: GOLD, letterSpacing: "4px", fontWeight: "bold" }}>WINNER</div>
              <div style={{ fontSize: "20px", color: GOLD, fontWeight: "bold", fontFamily: "Georgia, serif", marginTop: "2px" }}>Jay & Debbie</div>
              <div style={{ fontSize: "36px", fontWeight: "bold", color: GOLD, lineHeight: 1.1, textShadow: "0 0 16px rgba(200,168,78,0.6)" }}>520</div>
              <div style={{ fontSize: "12px", color: "#c0d0e0", marginTop: "2px" }}>vs Player 3 & 4 — 310</div>
              <div style={{ fontSize: "10px", color: "#8a9aaa", marginTop: "2px" }}>8 rounds played</div>
            </div>

            {/* MVP block */}
            <div style={{ background: "rgba(109,191,142,0.12)", border: "1px solid rgba(109,191,142,0.5)", borderRadius: "10px", padding: "10px 14px", display: "flex", alignItems: "center", gap: "12px" }}>
              <div style={{ fontSize: "28px" }}>🏆</div>
              <div>
                <div style={{ fontSize: "9px", color: GREEN, letterSpacing: "3px", fontWeight: "bold" }}>MVP OF THE GAME</div>
                <div style={{ fontSize: "20px", color: GREEN, fontWeight: "bold", fontFamily: "Georgia, serif" }}>Jay</div>
                <div style={{ fontSize: "11px", color: "#8ac8a0" }}>87% bid accuracy · Jay & Debbie</div>
              </div>
            </div>

            {/* Most bags block */}
            <div style={{ background: "rgba(232,148,58,0.35)", border: "1px solid rgba(232,148,58,0.8)", borderRadius: "10px", padding: "10px 14px", display: "flex", alignItems: "center", gap: "12px" }}>
              <div style={{ fontSize: "16px", background: "rgba(232,148,58,0.25)", borderRadius: "6px", padding: "4px 8px", color: ORANGE, fontWeight: "bold", letterSpacing: "1px" }}>BAGS</div>
              <div>
                <div style={{ fontSize: "9px", color: ORANGE, letterSpacing: "3px", fontWeight: "bold" }}>MOST BAGS THIS GAME</div>
                <div style={{ fontSize: "20px", color: ORANGE, fontWeight: "bold", fontFamily: "Georgia, serif" }}>Player 3</div>
                <div style={{ fontSize: "11px", color: "#c89060" }}>4 bags taken</div>
              </div>
            </div>

            {/* Career sandbagger */}
            <div style={{ background: "rgba(224,92,92,0.35)", border: "1px solid rgba(224,92,92,0.8)", borderRadius: "10px", padding: "10px 14px", display: "flex", alignItems: "center", gap: "12px" }}>
              <div style={{ fontSize: "16px", background: "rgba(224,92,92,0.25)", borderRadius: "6px", padding: "4px 6px", color: RED, fontWeight: "bold", letterSpacing: "1px" }}>⚠</div>
              <div>
                <div style={{ fontSize: "9px", color: RED, letterSpacing: "3px", fontWeight: "bold" }}>CAREER SANDBAGGER</div>
                <div style={{ fontSize: "20px", color: RED, fontWeight: "bold", fontFamily: "Georgia, serif" }}>Player 4</div>
                <div style={{ fontSize: "11px", color: "#c08080" }}>Consistent overtrick pattern</div>
              </div>
            </div>

            <div style={{ textAlign: "center", fontSize: "10px", color: GOLD, fontStyle: "italic", opacity: 0.7 }}>Play a full game to see your real summary ♠</div>
          </>
        ) : (
          // ─── Standard Cards ─────────────────────────────────────────────
          <>
            {/* Icon */}
            <div style={{ textAlign: "center", fontSize: "52px", lineHeight: 1 }}>{c.icon}</div>

            {/* Title */}
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: "22px", fontWeight: "bold", color: c.accent, fontFamily: "Georgia, serif", fontVariant: "small-caps", letterSpacing: "2px" }}>{c.title}</div>
              <div style={{ fontSize: "12px", color: "#6a7a8a", marginTop: "4px", letterSpacing: "2px", textTransform: "uppercase" }}>{c.subtitle}</div>
            </div>

            {/* Divider */}
            <div style={{ height: "1px", background: "linear-gradient(to right, transparent, " + c.accent + "60, transparent)" }} />

            {/* Body */}
            <div style={{ fontSize: "15px", color: "#c0d0e0", lineHeight: 1.7, fontFamily: "Georgia, serif", textAlign: "center", whiteSpace: "pre-line" }}>
              {c.body}
            </div>

            {/* Highlight pill */}
            {c.highlight && (
              <div style={{
                background: c.highlightColor + "15",
                border: "1px solid " + c.highlightColor + "40",
                borderRadius: "8px", padding: "10px 14px",
                textAlign: "center", fontSize: "12px",
                color: c.highlightColor, fontWeight: "bold",
                letterSpacing: "1px",
              }}>
                {c.highlight}
              </div>
            )}
          </>
        )}

        {/* Dot indicators */}
        <div style={{ display: "flex", justifyContent: "center", gap: "8px", marginTop: "4px" }}>
          {ONBOARDING_CARDS.map(function(_, i) {
            return (
              <div key={i} onClick={function() { goTo(i, i > card ? "left" : "right"); }}
                style={{
                  width: i === card ? "20px" : "8px", height: "8px",
                  borderRadius: "4px",
                  background: i === card ? c.accent : "rgba(255,255,255,0.15)",
                  transition: "all 0.3s ease",
                  cursor: "pointer",
                }} />
            );
          })}
        </div>

        {/* Buttons */}
        <div style={{ display: "flex", gap: "10px", marginTop: "4px" }}>
          {card > 0 && (
            <button onClick={prev} style={{
              flex: 1, background: "transparent",
              color: "#6a7a8a", border: "1px solid rgba(255,255,255,0.1)",
              borderRadius: "10px", padding: "14px",
              fontSize: "13px", fontFamily: "Georgia, serif",
              letterSpacing: "1px", cursor: "pointer",
            }}>← Back</button>
          )}
          <button onClick={next} style={{
            flex: 2, background: c.accent,
            color: "#080c18", border: "none",
            borderRadius: "10px", padding: "14px",
            fontSize: "14px", fontFamily: "Georgia, serif",
            fontWeight: "bold", letterSpacing: "2px",
            textTransform: "uppercase", cursor: "pointer",
            boxShadow: "0 0 20px " + c.accent + "50",
          }}>
            {isLast ? "Let's Play ♠" : "Next →"}
          </button>
        </div>

        {/* Skip */}
        {!isLast && (
          <div onClick={dismiss} style={{ textAlign: "center", fontSize: "11px", color: "#3a4a5a", cursor: "pointer", letterSpacing: "1px" }}>
            Skip intro
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────

// ─── Claim Profile flow (Phase B viral loop) ────────────────────
function parseClaimParams() {
  try {
    const q = new URLSearchParams(window.location.search);
    const code = q.get("claim");
    if (!code) return null;
    return { code: code, seat: q.get("seat"), name: q.get("name") ? decodeURIComponent(q.get("name")) : "" };
  } catch (_) { return null; }
}

function ClaimFlow({ code, seat, name, onClose }) {
  const [stage, setStage] = useState("checking");
  const [email, setEmail] = useState("");
  const [teaser, setTeaser] = useState(null);
  const [errMsg, setErrMsg] = useState("");

  useEffect(function() {
    let handled = false;
    function usable(sess) { return sess && sess.user && !sess.user.is_anonymous; }
    async function doClaim() {
      setStage("claiming");
      try {
        const res = await supabase.functions.invoke("game-claim", { body: { code: code, seat: Number(seat) } });
        const data = res && res.data;
        if ((res && res.error) || !data || data.error) { setErrMsg((data && data.error) || "claim_failed"); setStage("error"); return; }
        setTeaser(data); setStage("done");
      } catch (_) { setErrMsg("network"); setStage("error"); }
    }
    async function check() {
      try {
        const { data } = await supabase.auth.getSession();
        if (usable(data.session)) { handled = true; doClaim(); return; }
      } catch (_) {}
      if (window.location.hash && window.location.hash.indexOf("access_token") >= 0) {
        setStage("checking");
        setTimeout(function() { setStage(function(st) { return st === "checking" ? "input" : st; }); }, 6000);
        return;
      }
      setStage("input");
    }
    check();
    const sub = supabase.auth.onAuthStateChange(function(_evt, session) {
      if (!handled && usable(session)) { handled = true; doClaim(); }
    });
    return function() { try { sub.data.subscription.unsubscribe(); } catch (_) {} };
  }, []);

  async function sendLink() {
    if (!email || email.indexOf("@") < 1) { setErrMsg("Enter a valid email."); return; }
    setErrMsg(""); setStage("sending");
    try {
      const { error } = await supabase.auth.signInWithOtp({ email: email.trim(), options: { emailRedirectTo: window.location.href } });
      if (error) { setErrMsg(error.message || "Couldn't send the link."); setStage("input"); }
      else setStage("sent");
    } catch (_) { setErrMsg("Couldn't send the link."); setStage("input"); }
  }

  function shell(children) {
    return (
      <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.9)", zIndex: 500, display: "flex", alignItems: "center", justifyContent: "center", padding: "24px", backdropFilter: "blur(8px)" }}>
        <div style={{ background: "#141926", border: "1px solid rgba(200,168,78,0.4)", borderRadius: "16px", padding: "26px", width: "100%", maxWidth: "360px", textAlign: "center", boxShadow: "0 0 40px rgba(0,0,0,0.6)" }}>
          <div style={{ fontSize: "30px", color: GOLD }}>♠</div>
          {children}
        </div>
      </div>
    );
  }

  if (stage === "checking" || stage === "claiming") {
    return shell(<div style={{ color: "#8aaabb", fontSize: "14px", marginTop: "14px" }}>{stage === "claiming" ? "Claiming your profile…" : "One sec…"}</div>);
  }
  if (stage === "sent") {
    return shell(
      <div>
        <div style={{ fontSize: "17px", color: GOLD, fontWeight: "bold", margin: "10px 0" }}>Check your email</div>
        <div style={{ fontSize: "13px", color: "#c8d8e8", lineHeight: "1.5" }}>We sent a one-tap sign-in link to <b>{email}</b>. Open it <b>on this device</b> to finish claiming {name || "your profile"}.</div>
        <button onClick={onClose} style={{ marginTop: "18px", background: "transparent", color: "#7a8a9a", border: "none", fontSize: "12px", textDecoration: "underline", cursor: "pointer" }}>Close</button>
      </div>
    );
  }
  if (stage === "done") {
    if (teaser && teaser.alreadyOther) {
      return shell(
        <div>
          <div style={{ fontSize: "17px", color: "#e05c5c", fontWeight: "bold", margin: "10px 0" }}>Already claimed</div>
          <div style={{ fontSize: "13px", color: "#c8d8e8" }}>{name || "This profile"} has already been claimed by someone else.</div>
          <button onClick={onClose} style={{ marginTop: "18px", background: GOLD, color: "#0a0e1b", border: "none", borderRadius: "10px", padding: "12px 22px", fontSize: "13px", fontWeight: "bold", cursor: "pointer" }}>Continue</button>
        </div>
      );
    }
    return shell(
      <div>
        <div style={{ fontSize: "12px", color: "#4a8a6a", letterSpacing: "2px", marginTop: "8px" }}>PROFILE CLAIMED</div>
        <div style={{ fontSize: "22px", color: GOLD, fontWeight: "bold", margin: "4px 0 14px" }}>{(teaser && teaser.name) || name}</div>
        <div style={{ display: "flex", justifyContent: "center", gap: "18px", marginBottom: "6px" }}>
          <div><div style={{ fontSize: "24px", color: GREEN, fontWeight: "bold" }}>{teaser ? teaser.gamesPlayed : 0}</div><div style={{ fontSize: "10px", color: "#8aaabb" }}>GAMES</div></div>
          <div><div style={{ fontSize: "24px", color: GREEN, fontWeight: "bold" }}>{teaser ? teaser.gamesWon : 0}</div><div style={{ fontSize: "10px", color: "#8aaabb" }}>WINS</div></div>
          <div><div style={{ fontSize: "24px", color: GOLD, fontWeight: "bold" }}>{teaser ? teaser.winRate : 0}%</div><div style={{ fontSize: "10px", color: "#8aaabb" }}>WIN RATE</div></div>
        </div>
        <div style={{ fontSize: "11px", color: "#6a7a8a", margin: "10px 0 4px" }}>Your games are now tied to this profile.</div>
        <button onClick={onClose} style={{ marginTop: "14px", background: GOLD, color: "#0a0e1b", border: "none", borderRadius: "10px", padding: "12px 26px", fontSize: "13px", fontWeight: "bold", cursor: "pointer" }}>Continue</button>
      </div>
    );
  }
  if (stage === "error") {
    return shell(
      <div>
        <div style={{ fontSize: "16px", color: "#e05c5c", fontWeight: "bold", margin: "10px 0" }}>Something went wrong</div>
        <div style={{ fontSize: "12px", color: "#c8d8e8" }}>{errMsg || "Please try again."}</div>
        <div style={{ marginTop: "16px" }}>
          <button onClick={function() { setErrMsg(""); setStage("input"); }} style={{ background: GOLD, color: "#0a0e1b", border: "none", borderRadius: "10px", padding: "10px 20px", fontSize: "12px", fontWeight: "bold", cursor: "pointer", marginRight: "8px" }}>Try again</button>
          <button onClick={onClose} style={{ background: "transparent", color: "#7a8a9a", border: "none", fontSize: "12px", textDecoration: "underline", cursor: "pointer" }}>Close</button>
        </div>
      </div>
    );
  }
  return shell(
    <div>
      <div style={{ fontSize: "17px", color: GOLD, fontWeight: "bold", margin: "10px 0 2px" }}>Claim {name || "your profile"}</div>
      <div style={{ fontSize: "12px", color: "#8aaabb", marginBottom: "16px", lineHeight: "1.5" }}>Enter your email and we'll send a one-tap sign-in link. No password — your games stay tied to you.</div>
      <input type="email" inputMode="email" autoCapitalize="none" value={email} onChange={function(e) { setEmail(e.target.value); }} placeholder="you@email.com"
        style={{ width: "100%", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(200,168,78,0.3)", borderRadius: "10px", padding: "13px", fontSize: "15px", color: "#e6edf5", textAlign: "center", marginBottom: "10px" }} />
      {errMsg && <div style={{ fontSize: "11px", color: "#e05c5c", marginBottom: "8px" }}>{errMsg}</div>}
      <button onClick={sendLink} disabled={stage === "sending"} style={{ width: "100%", background: GOLD, color: "#0a0e1b", border: "none", borderRadius: "10px", padding: "14px", fontSize: "14px", fontWeight: "bold", letterSpacing: "1px", cursor: "pointer" }}>{stage === "sending" ? "Sending…" : "Send sign-in link"}</button>
      <button onClick={onClose} style={{ marginTop: "12px", background: "transparent", color: "#7a8a9a", border: "none", fontSize: "12px", textDecoration: "underline", cursor: "pointer" }}>Not now</button>
    </div>
  );
}

// ─── Live cloud writes (TV / Chromecast foundation) ────────
// Push state to the cloud AS IT HAPPENS (game start + each round) so a live TV
// view has something mid-game. Best-effort, swallowed, local-first. The
// end-of-game push (pushGameToCloud/pushRelationalGame) stays as the backstop.
var __btsParticipants = {};
function genCloudId() {
  try { return crypto.randomUUID(); }
  catch (_) { return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function(c){ var r = Math.random()*16|0; return (c === "x" ? r : (r & 0x3 | 0x8)).toString(16); }); }
}
async function cloudStartGame(cloudGameId, clientId, shareCode, teams, rules) {
  try {
    if (!cloudGameId || !teams || teams.length !== 2) return;
    const { data: u } = await supabase.auth.getUser();
    const user = u && u.user; if (!user) return;
    const { data: gRow } = await supabase.from("games").upsert({
      id: cloudGameId, owner_id: user.id, client_id: clientId,
      status: "in_progress", started_at: new Date().toISOString(), played_at: new Date(clientId).toISOString(),
      share_code: shareCode, winner_team: null, total_rounds: 0,
      rules: rules || null,
      teams: teams.map(function(t){ return { name: t.name, score: 0, bags: 0, p: [t.p[0], t.p[1]] }; }),
      rounds: [],
    }, { onConflict: "owner_id,client_id" }).select("short_code").single();
    const shortCode = gRow ? gRow.short_code : null;
    // Exactly one game may be live at a time. Anything else still marked
    // in_progress is abandoned, and would otherwise hijack the TV.
    try {
      await supabase.from("games")
        .update({ status: "completed", ended_at: new Date().toISOString(), live_state: null })
        .eq("owner_id", user.id).eq("status", "in_progress").neq("id", cloudGameId);
    } catch (_) {}
    const seatDefs = [
      { name: teams[0].p[0], team: 0, seat: 0 }, { name: teams[1].p[0], team: 1, seat: 1 },
      { name: teams[0].p[1], team: 0, seat: 2 }, { name: teams[1].p[1], team: 1, seat: 3 },
    ];
    if (seatDefs.some(function(x){ return !x.name; })) return shortCode;
    const uniq = Array.from(new Set(seatDefs.map(function(x){ return String(x.name).toLowerCase(); })));
    if (uniq.length !== 4) return shortCode;
    const seatToPid = await cloudResolveSeatPlayerIds(user.id, seatDefs);
    if (!seatToPid) return shortCode;
    __btsParticipants[cloudGameId] = seatToPid;
    await supabase.from("game_participants").upsert(
      seatDefs.map(function(x){ return { game_id: cloudGameId, player_id: seatToPid[x.seat], team: x.team, seat: x.seat }; }),
      { onConflict: "game_id,seat" });
    return shortCode;
  } catch (_) {}
}
async function cloudUpdateRules(cloudGameId, rules) {
  try {
    if (!cloudGameId) return;
    await supabase.from("games").update({ rules: rules || null }).eq("id", cloudGameId);
  } catch (_) {}
}
// Resolve seat -> player_id, case-insensitively.
//
// players has UNIQUE (owner_id, lower(name)). Upserting "ZzDebbie" when a row
// "Zzdebbie" already exists violates that index, so the write errors, no ids come
// back, participants are never created, and cloudPushRound silently bails on every
// round for the rest of the game - the score simply never moves. Match on
// lower(name) and only insert names that genuinely do not exist yet.
async function cloudResolveSeatPlayerIds(ownerId, seatDefs) {
  const names = Array.from(new Set(seatDefs.map(function(x){ return x.name; })));
  const { data: existing } = await supabase.from("players").select("id,name").eq("owner_id", ownerId);
  const idByLower = {};
  (existing || []).forEach(function(r){ idByLower[String(r.name).toLowerCase()] = r.id; });
  const missing = names.filter(function(n){ return !idByLower[String(n).toLowerCase()]; });
  if (missing.length) {
    const { data: ins } = await supabase.from("players")
      .insert(missing.map(function(n){ return { owner_id: ownerId, name: n }; }))
      .select("id,name");
    (ins || []).forEach(function(r){ idByLower[String(r.name).toLowerCase()] = r.id; });
  }
  const seatToPid = {};
  for (var i = 0; i < seatDefs.length; i++) {
    const pid = idByLower[String(seatDefs[i].name).toLowerCase()];
    if (!pid) return null;                 // never write a participant with a null id
    seatToPid[seatDefs[i].seat] = pid;
  }
  return seatToPid;
}

async function cloudEnsureParticipants(cloudGameId, teams) {
  if (__btsParticipants[cloudGameId]) return __btsParticipants[cloudGameId];
  try {
    const { data: parts } = await supabase.from("game_participants").select("seat, player_id").eq("game_id", cloudGameId);
    if (parts && parts.length === 4) {
      const m = {}; parts.forEach(function(p){ m[p.seat] = p.player_id; });
      __btsParticipants[cloudGameId] = m; return m;
    }
    // SELF-HEAL. cloudStartGame runs exactly once per game and returns silently
    // if the player names were not populated at that instant. Without a rebuild
    // here, cloudPushRound bails on every round for the rest of the game and the
    // score never moves - which is exactly what happened to game K9ZU7V.
    if (!teams || teams.length !== 2 || !teams[0].p || !teams[1].p) return null;
    const { data: u } = await supabase.auth.getUser();
    const user = u && u.user; if (!user) return null;
    const seatDefs = [
      { name: teams[0].p[0], team: 0, seat: 0 }, { name: teams[1].p[0], team: 1, seat: 1 },
      { name: teams[0].p[1], team: 0, seat: 2 }, { name: teams[1].p[1], team: 1, seat: 3 },
    ];
    if (seatDefs.some(function(x){ return !x.name; })) return null;
    const uniq = Array.from(new Set(seatDefs.map(function(x){ return String(x.name).toLowerCase(); })));
    if (uniq.length !== 4) return null;
    const m2 = await cloudResolveSeatPlayerIds(user.id, seatDefs);
    if (!m2) return null;
    await supabase.from("game_participants").upsert(
      seatDefs.map(function(x){ return { game_id: cloudGameId, player_id: m2[x.seat], team: x.team, seat: x.seat }; }),
      { onConflict: "game_id,seat" });
    __btsParticipants[cloudGameId] = m2; return m2;
  } catch (_) { return null; }
}

async function cloudPushRound(cloudGameId, teams, round, newTeams) {
  try {
    if (!cloudGameId || !round || !round.entry || round.entry.length !== 2) return false;
    const seatToPid = await cloudEnsureParticipants(cloudGameId, teams);
    if (!seatToPid) return false;
    const e0 = round.entry[0], e1 = round.entry[1], res = round.results || [], pen = round.penalties || [0, 0];
    function tBid(e){ return (e.p1nil > 0 ? 0 : (parseInt(e.p1bid) || 0)) + (e.p2nil > 0 ? 0 : (parseInt(e.p2bid) || 0)); }
    function tTricks(e){ return (parseInt(e.p1tricks) || 0) + (parseInt(e.p2tricks) || 0); }
    var dealerSeat = null;
    if (round.dealer) { var ds = [ {n:teams[0].p[0],s:0},{n:teams[1].p[0],s:1},{n:teams[0].p[1],s:2},{n:teams[1].p[1],s:3} ].find(function(x){ return x.n === round.dealer; }); dealerSeat = ds ? ds.s : null; }
    const t0 = tTricks(e0), t1 = tTricks(e1);
    if (t0 + t1 !== 13) return false;
    const roundRow = {
      game_id: cloudGameId, round_number: round.num, dealer_seat: dealerSeat,
      team_0_bid: tBid(e0), team_1_bid: tBid(e1), team_0_tricks: t0, team_1_tricks: t1,
      team_0_score_delta: ((res[0] && res[0].pts) || 0) + (pen[0] || 0),
      team_1_score_delta: ((res[1] && res[1].pts) || 0) + (pen[1] || 0),
      // round.bagsAfter is the truth for THIS round. newTeams is only a fallback
      // for rounds recorded before bagsAfter existed - it holds the CURRENT count,
      // which is wrong for any round pushed in a catch-up batch.
      team_0_bags_after: (round.bagsAfter ? round.bagsAfter[0] : (newTeams && newTeams[0] ? newTeams[0].bags : 0)),
      team_1_bags_after: (round.bagsAfter ? round.bagsAfter[1] : (newTeams && newTeams[1] ? newTeams[1].bags : 0)),
      team_0_bag_penalty_applied: pen[0] || 0, team_1_bag_penalty_applied: pen[1] || 0,
    };
    const { data: rRow } = await supabase.from("rounds").upsert([roundRow], { onConflict: "game_id,round_number" }).select("id").single();
    if (!rRow || !rRow.id) return false;
    const roundId = rRow.id, rpRows = [];
    [0, 1].forEach(function(ti){
      const en = round.entry[ti]; if (!en) return;
      [["p1", ti === 0 ? 0 : 1], ["p2", ti === 0 ? 2 : 3]].forEach(function(pair){
        const pk = pair[0], seat = pair[1], nil = en[pk + "nil"], tricks = parseInt(en[pk + "tricks"]) || 0;
        const nilType = nil === 2 ? "blind_nil" : (nil === 1 ? "nil" : null);
        rpRows.push({ round_id: roundId, player_id: seatToPid[seat], seat: seat, bid: nilType ? 0 : (parseInt(en[pk + "bid"]) || 0), tricks_taken: tricks, nil_type: nilType, nil_succeeded: nilType ? (tricks === 0) : null });
      });
    });
    await supabase.from("round_players").upsert(rpRows, { onConflict: "round_id,seat" });
    await supabase.from("games").update({ total_rounds: round.num }).eq("id", cloudGameId);
    return true;
  } catch (_) { return false; }
}
// Live in-round state for the TV: bids as they're entered, dealer, active seat.
// Ephemeral by design — overwritten on every (debounced) change and cleared when
// the game ends. rounds/round_players stay the source of truth for history, so a
// dropped write here costs nothing: the next one self-heals it.
// Instant path to the TV. Shapes the payload into the same structure the edge
// function returns, so the scoreboard renders identically whether the state
// arrived by broadcast (~40ms) or by the 2s poll.
let _liveChan = null, _liveChanId = null;
function broadcastLive(cloudGameId, raw) {
  try {
    if (!cloudGameId) return;
    if (_liveChanId !== cloudGameId) {
      if (_liveChan) { try { supabase.removeChannel(_liveChan); } catch (_) {} }
      _liveChan = supabase.channel("live:" + cloudGameId);
      _liveChan.subscribe();
      _liveChanId = cloudGameId;
    }
    var shaped = null;
    if (raw) {
      var seatsOut = [0, 1, 2, 3].map(function(seat) {
        var b = raw.bids ? raw.bids[seat] : null;
        var n = raw.nils ? (raw.nils[seat] || 0) : 0;
        return { seat: seat, team: seat % 2, name: (raw.names || [])[seat] || ("Seat " + seat),
                 bid: (b === undefined) ? null : b, nil: n,
                 dealer: raw.dealerSeat === seat, active: raw.activeBidSeat === seat };
      });
      var totals = [0, 1].map(function(t) {
        return seatsOut.filter(function(x) { return x.team === t; })
          .reduce(function(a, x) { return a + (x.nil > 0 ? 0 : (x.bid || 0)); }, 0);
      });
      var declared = seatsOut.filter(function(x) { return x.nil > 0 || x.bid !== null; }).length;
      shaped = { round: raw.round, seats: seatsOut, totals: totals, declared: declared,
                 complete: declared === 4, activeBidSeat: raw.activeBidSeat,
                 // secs MUST ride along. The broadcast override BEATS the 2s poll,
                 // so if this shape omits the clock length the TV throws away the
                 // correct value the poll just delivered and falls back to its own
                 // default on every keystroke. That is exactly why the TV showed 25
                 // when the rule said 15, and then 20 when the rule said 15 - it was
                 // never reading the setting at all, only the constant.
                 secs: (raw.secs === 0 || raw.secs) ? raw.secs : null,
                 bidStartedAt: raw.bidStartedAt, armed: raw.armed !== false };
    }
    _liveChan.send({ type: "broadcast", event: "live", payload: { live: shaped, sentAt: Date.now() } });
  } catch (_) {}
}
async function cloudEndGame(cloudGameId) {
  try {
    if (!cloudGameId) return;
    await supabase.from("games")
      .update({ status: "completed", ended_at: new Date().toISOString(), live_state: null })
      .eq("id", cloudGameId).eq("status", "in_progress");
  } catch (_) {}
}
async function cloudPushLive(cloudGameId, live) {
  try {
    if (!cloudGameId) return;
    await supabase.from("games").update({ live_state: live }).eq("id", cloudGameId);
  } catch (_) {}
}
async function cloudDeleteRound(cloudGameId, roundNumber) {
  try { if (cloudGameId && roundNumber) { await supabase.from("rounds").delete().eq("game_id", cloudGameId).eq("round_number", roundNumber); await supabase.from("games").update({ total_rounds: roundNumber - 1 }).eq("id", cloudGameId); } } catch (_) {}
}

// "Debbie and Jay wins" is wrong - a compound name is a plural subject. Pick the
// verb from the name so both "Debbie and Jay win" and "Team 1 wins" read right.
function winVerb(name) {
  return /\s(and|&|\+)\s/i.test(String(name || "")) ? "win" : "wins";
}

// ── HOLD MY BEER, the morning after ────────────────────────────────────────
// The bid-time banner fires off live_state. This is the payoff once the hand is
// played out. Computed from event.teams[].players[], which the TV already
// receives - no extra request, no edge function change.
function hmbPayoff(ev) {
  try {
    if (!ev || !Array.isArray(ev.teams)) return null;
    for (var i = 0; i < ev.teams.length; i++) {
      var t = ev.teams[i];
      var bid = t.bid || 0, trk = t.tricks || 0;
      if (bid >= 11) {
        return trk >= bid
          ? { type: "heldMyBeer", headline: "HELD MY BEER", sub: t.name + " bid " + bid + " and made it", team: i }
          : { type: "spilledIt", headline: "SPILLED IT", sub: t.name + " bid " + bid + ", took " + trk, team: i };
      }
    }
    var best = null;
    for (var k = 0; k < ev.teams.length; k++) {
      var ps = ev.teams[k].players || [];
      for (var m = 0; m < ps.length; m++) {
        var pl = ps[m];
        if (pl.nil) continue;
        var pb = pl.bid || 0;
        if (pb >= 6 && (!best || pb > best.bid)) best = { name: pl.name, bid: pb, tricks: pl.tricks || 0, team: k };
      }
    }
    if (!best) return null;
    return best.tricks >= best.bid
      ? { type: "heldMyBeer", headline: "HELD MY BEER", sub: best.name + " bid " + best.bid + " solo and delivered", team: best.team }
      : { type: "droppedIt", headline: "DROPPED THE BEER", sub: best.name + " bid " + best.bid + ", took " + best.tricks, team: best.team };
  } catch (_) { return null; }
}

function parseTvCode() {
  try { return new URLSearchParams(window.location.search).get("tv") || null; } catch (_) { return null; }
}

// ── Bid clock ────────────────────────────────────────────────────────────────
// 15 seconds per bid. The cue tones and the explosion are SYNTHESISED with Web
// Audio (oscillators + a noise buffer) rather than shipped as audio files: no
// licensing, no CDN, nothing to 404, and it adds ~0kb to the bundle.
const BID_SECONDS = 20;   // fallback only - rules.bidSeconds is the real value

// Bump this whenever a build ships. The TV footer prints it, so "is that screen
// running the current build?" stops being a guess. Three separate sessions were
// lost to a stale bundle that looked identical to the current one.
const BUILD_TAG = "2026-08-20d";
const TICK_HZ = { 5: 440, 4: 523, 3: 622, 2: 740, 1: 880 };

function makeBidAudio() {
  try {
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    var ctx = new Ctx();

    // Master chain. TV speakers roll off hard below ~100Hz and have no headroom,
    // so the trick is loudness in the 200Hz-4kHz band, not sub-bass. Soft-clip
    // for grit, then compress so peaks stay controlled while everything is LOUD.
    var master = ctx.createGain(); master.gain.value = 0.95;
    var drive = ctx.createWaveShaper();
    (function () {
      var n = 2048, curve = new Float32Array(n), k = 12;
      for (var i = 0; i < n; i++) { var x = (i * 2) / n - 1; curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x)); }
      drive.curve = curve; drive.oversample = "4x";
    })();
    var comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -12; comp.knee.value = 6; comp.ratio.value = 10;
    comp.attack.value = 0.002; comp.release.value = 0.18;
    master.connect(drive); drive.connect(comp); comp.connect(ctx.destination);

    function noise(dur, curvePow) {
      var len = Math.max(1, Math.floor(ctx.sampleRate * dur));
      var buf = ctx.createBuffer(1, len, ctx.sampleRate);
      var d = buf.getChannelData(0);
      for (var i = 0; i < len; i++) {
        var k = 1 - i / len;
        d[i] = (Math.random() * 2 - 1) * Math.pow(k, curvePow);
      }
      var src = ctx.createBufferSource(); src.buffer = buf; return src;
    }

    // One hit of the countdown cue: a war-drum thud with a metallic click on top.
    function hit(t, freq, gain, dur) {
      var o = ctx.createOscillator(), g = ctx.createGain();
      o.type = "square";
      o.frequency.setValueAtTime(freq * 2.2, t);
      o.frequency.exponentialRampToValueAtTime(freq, t + 0.05);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(gain, t + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      var lp = ctx.createBiquadFilter();
      lp.type = "lowpass"; lp.frequency.value = 2600; lp.Q.value = 6;
      o.connect(lp); lp.connect(g); g.connect(master);
      o.start(t); o.stop(t + dur + 0.02);
      // Click transient so it cuts through a room full of people talking.
      var nz = noise(0.05, 3), nf = ctx.createBiquadFilter(), ng = ctx.createGain();
      nf.type = "highpass"; nf.frequency.value = 1800;
      ng.gain.setValueAtTime(gain * 0.7, t);
      ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
      nz.connect(nf); nf.connect(ng); ng.connect(master); nz.start(t);
    }

    // Countdown cue. Double-thump, like a heartbeat, tightening and rising as
    // the clock runs down - far more menacing than a single blip.
    function tick(freq) {
      var t = ctx.currentTime;
      var urgency = Math.max(0, Math.min(1, (freq - 440) / 440));   // 0 at 5s, 1 at 1s
      var gap = 0.16 - urgency * 0.06;
      var base = 110 + urgency * 90;
      var gain = 0.55 + urgency * 0.35;
      hit(t, base, gain, 0.20);
      hit(t + gap, base * 1.5, gain * 0.95, 0.24);
    }

    // The buzzer. Four layers, all kept inside what a TV can actually reproduce.
    function boom() {
      var t = ctx.currentTime;

      // 1) Crack - the initial transient.
      var cz = noise(0.09, 2), cf = ctx.createBiquadFilter(), cg = ctx.createGain();
      cf.type = "highpass"; cf.frequency.value = 1200;
      cg.gain.setValueAtTime(0.95, t); cg.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
      cz.connect(cf); cf.connect(cg); cg.connect(master); cz.start(t);

      // 2) Body - noise through a resonant lowpass sweeping down, but stopping at
      //    300Hz rather than 110Hz so a TV speaker can still move air.
      var bz = noise(1.9, 1.6), bf = ctx.createBiquadFilter(), bg = ctx.createGain();
      bf.type = "lowpass"; bf.Q.value = 4;
      bf.frequency.setValueAtTime(4200, t);
      bf.frequency.exponentialRampToValueAtTime(300, t + 1.5);
      bg.gain.setValueAtTime(0.9, t); bg.gain.exponentialRampToValueAtTime(0.0001, t + 1.9);
      bz.connect(bf); bf.connect(bg); bg.connect(master); bz.start(t);

      // 3) Rumble - two detuned saws beating against each other for grit.
      [82, 87].forEach(function (f, idx) {
        var o = ctx.createOscillator(), g = ctx.createGain(), lp = ctx.createBiquadFilter();
        o.type = "sawtooth";
        o.frequency.setValueAtTime(f * 3, t);
        o.frequency.exponentialRampToValueAtTime(f, t + 0.5);
        lp.type = "lowpass"; lp.frequency.setValueAtTime(1400, t);
        lp.frequency.exponentialRampToValueAtTime(220, t + 2.2);
        g.gain.setValueAtTime(0.5 - idx * 0.1, t);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 2.4);
        o.connect(lp); lp.connect(g); g.connect(master);
        o.start(t); o.stop(t + 2.45);
      });

      // 4) Power-down siren, the "you're done" tail.
      var o2 = ctx.createOscillator(), g2 = ctx.createGain();
      o2.type = "square";
      o2.frequency.setValueAtTime(520, t + 0.04);
      o2.frequency.exponentialRampToValueAtTime(90, t + 1.1);
      g2.gain.setValueAtTime(0.0001, t);
      g2.gain.exponentialRampToValueAtTime(0.45, t + 0.06);
      g2.gain.exponentialRampToValueAtTime(0.0001, t + 1.3);
      o2.connect(g2); g2.connect(master);
      o2.start(t); o2.stop(t + 1.35);
    }

    return { ctx: ctx, tick: tick, boom: boom };
  } catch (_) { return null; }
}

function bagPips(bags, limit) {
  var n = (limit > 0) ? limit : 10;
  var filled = Math.max(0, Math.min(n, bags || 0));
  var hot = filled >= n - 1, warm = !hot && filled >= n - 3;
  var col = hot ? "#e0605c" : (warm ? "#e8943a" : "rgba(200,168,78,0.85)");
  if (n > 15) {
    return (
      <div style={{ height: "0.9vh", width: "70%", margin: "0.9vh auto 0", background: "rgba(255,255,255,0.10)", borderRadius: "99px", overflow: "hidden" }}>
        <div style={{ width: ((filled / n) * 100) + "%", height: "100%", background: col, borderRadius: "99px", transition: "width 0.4s ease, background 0.4s ease" }} />
      </div>
    );
  }
  var pips = [];
  for (var i = 0; i < n; i++) {
    pips.push(<span key={i} style={{ width: "1.7vh", height: "1.7vh", borderRadius: "50%", background: i < filled ? col : "rgba(255,255,255,0.12)", boxShadow: (i < filled && hot) ? "0 0 1.6vh rgba(224,96,92,0.8)" : "none", transition: "background 0.4s ease" }} />);
  }
  return <div style={{ display: "flex", justifyContent: "center", gap: "1vh", marginTop: "1.2vh" }}>{pips}</div>;
}

function TVScoreboard({ code }) {
  const [d, setD] = React.useState(null);
  const [liveOverride, setLiveOverride] = React.useState(null);   // instant state via Realtime
  // The 2s poll goes through the edge function, which builds `live` field by field
  // and does NOT carry `secs`. Only the Realtime broadcast has it. Without a memory
  // here the clock length flips back to the default every time the poll wins a
  // render - the phone says 15 and the TV counts 25.
  const seenSecs = React.useRef(null);
  const [audio, setAudio] = React.useState(null);
  const [audioAsked, setAudioAsked] = React.useState(false);
  const [muted, setMuted] = React.useState(false);
  const [nowTick, setNowTick] = React.useState(0);
  const clockOffset = React.useRef(0);   // ms to add to this TV's clock to match the scorekeeper's
  const fired = React.useRef({});
  const [waiting, setWaiting] = React.useState(true);
  const [banner, setBanner] = React.useState(null);
  const [reelIdx, setReelIdx] = React.useState(0);
  const lastBannerRound = React.useRef(-1);
  const bannerTimer = React.useRef(null);
  React.useEffect(function() {
    var alive = true;
    async function tick() {
      try {
        var res = await supabase.functions.invoke("tv", { body: { c: code } });
        var j = res && res.data;
        if (!alive) return;
        if (j && !j.error) {
          setD(j); setWaiting(false);
          // Seed the remembered clock length from the poll too. Previously this
          // ref was only ever written by a broadcast, so a TV whose scorekeeper
          // runs an older build - or that joined mid-round - had nothing to fall
          // back to but the hardcoded default.
          if (j.live && (j.live.secs === 0 || j.live.secs)) seenSecs.current = j.live.secs;
          var payoff = j.mode === "live" ? hmbPayoff(j.event) : null;
          if (j.mode === "live" && j.event && (j.event.banner || payoff) && j.event.roundNumber !== lastBannerRound.current) {
            lastBannerRound.current = j.event.roundNumber;
            // The payoff outranks whatever the server picked - somebody made a
            // spectacle of themselves and the table wants to see how it ended.
            setBanner(payoff || j.event.banner);
            if (bannerTimer.current) clearTimeout(bannerTimer.current);
            bannerTimer.current = setTimeout(function() { setBanner(null); }, 6500);
          }
          if (j.mode !== "live" && banner) setBanner(null);
        } else { setWaiting(true); }
      } catch (_) {}
    }
    tick();
    var iv = setInterval(tick, 2000);
    return function() { alive = false; clearInterval(iv); if (bannerTimer.current) clearTimeout(bannerTimer.current); };
  }, []);
  // Drive the countdown locally. 10fps is plenty for a draining bar and is far
  // kinder to a TV browser than requestAnimationFrame.
  React.useEffect(function() {
    var iv = setInterval(function() { setNowTick(Date.now()); }, 100);
    return function() { clearInterval(iv); };
  }, []);

  // Realtime broadcast. Polling every 2s cannot arbitrate a 15s countdown: a bid
  // entered at 13.5s could land after the TV already fired the explosion. The
  // scorekeeper broadcasts each change and it arrives in well under 100ms, so the
  // reset always beats the zero-crossing. The 2s poll stays as the fallback that
  // seeds state for a TV joining mid-round.
  var gameId = d && d.gameId;
  React.useEffect(function() {
    if (!gameId) return;
    var ch = supabase.channel("live:" + gameId);
    ch.on("broadcast", { event: "live" }, function(msg) {
      var p = msg && msg.payload;
      if (!p) return;
      if (p.sentAt) clockOffset.current = p.sentAt - Date.now();
      if (p.live && (p.live.secs === 0 || p.live.secs)) seenSecs.current = p.live.secs;
      setLiveOverride(p.live ? Object.assign({}, p.live, { __game: gameId }) : null);
    });
    ch.subscribe();
    return function() {
      // A new game means the previous game's broadcast is dead weight. Without
      // this the override outlives the game it came from and freezes the bid
      // strip on the old roster while the team panels move on.
      setLiveOverride(null);
      seenSecs.current = null;
      try { supabase.removeChannel(ch); } catch (_) {}
    };
  }, [gameId]);

  var reelLen = (d && d.mode === "recap" && d.highlights) ? d.highlights.length : 0;
  React.useEffect(function() {
    if (reelLen <= 1) return;
    var iv = setInterval(function() { setReelIdx(function(i) { return (i + 1) % reelLen; }); }, 5000);
    return function() { clearInterval(iv); };
  }, [reelLen]);

  var container = { position: "fixed", inset: 0, background: "#0a0e1b", backgroundImage: "radial-gradient(ellipse at 20% 30%,#0c1e3a 0%,transparent 55%),radial-gradient(ellipse at 85% 80%,#180a2a 0%,transparent 55%)", color: "#e6edf5", fontFamily: "Georgia, serif", display: "flex", flexDirection: "column", padding: "3vh 3vw", overflow: "hidden", zIndex: 99999 };
  var foot = { textAlign: "center", color: "#4a5a6a", fontSize: "1.8vh", fontFamily: "Arial, sans-serif" };

  // NOTE: every hook below must stay ABOVE the recap/empty early returns.
  // Hook order has to be identical on every render - putting a hook after an
  // early return crashes the component the moment the mode changes.
  // Realtime wins when present (sub-100ms); the 2s poll seeds a TV joining late.
  // Realtime wins when present (sub-100ms) - but only while it still describes the
  // game and round the poll is reporting. An override from a finished game, or one
  // left behind by a round that has since been scored, is stale and must lose.
  var polled = (d && d.live && d.live.seats) ? d.live : null;
  var ovr = liveOverride;
  if (ovr) {
    var wrongGame = ovr.__game && d && d.gameId && ovr.__game !== d.gameId;
    var expectRound = (d && typeof d.round === "number") ? d.round + 1 : null;
    var wrongRound = (expectRound !== null && typeof ovr.round === "number" && ovr.round !== expectRound);
    if (wrongGame || wrongRound || !ovr.seats) ovr = null;
  }
  var live = ovr || polled;
  var timer = null;
  if (live && live.bidStartedAt && live.activeBidSeat !== null && live.activeBidSeat !== undefined) {
    var elapsedMs = (Date.now() + clockOffset.current) - live.bidStartedAt;
    // live.secs -> last value any broadcast carried -> default. Never silently 25
    // just because this render came from the poll instead of Realtime.
    var secs = (live.secs === 0 || live.secs) ? live.secs
             : ((seenSecs.current === 0 || seenSecs.current) ? seenSecs.current : BID_SECONDS);
    if (secs > 0) timer = { remaining: secs - (elapsedMs / 1000), key: live.activeBidSeat + ":" + live.bidStartedAt, secs: secs };
  }
  // Cue tones on each of the last 5 seconds, explosion at zero. Keyed on
  // seat+start so a new bidder rearms everything, and the boom only fires if we
  // actually watched the clock run down — never on a stale state after a reload.
  React.useEffect(function() {
    if (!audio || muted || !timer) return;
    if (fired.current.key !== timer.key) fired.current = { key: timer.key };
    var f = fired.current;
    if (timer.remaining > 0) {
      f.sawRunning = true;
      var secs = Math.ceil(timer.remaining);
      if (secs <= 5 && !f["t" + secs]) { f["t" + secs] = true; audio.tick(TICK_HZ[secs] || 440); }
    } else if (f.sawRunning && !f.boom) {
      f.boom = true; audio.boom();
    }
  }, [nowTick, audio, muted, timer ? timer.key : null]);
  // Fires once when the fourth bid lands. Purely client-side: every bid is
  // already in `live`, so this costs no extra round trip.
  const [liveBanner, setLiveBanner] = React.useState(null);
  const liveBannerKey = React.useRef(null);
  React.useEffect(function() {
    if (!live || !live.complete || !live.totals) { return; }
    var total = (live.totals[0] || 0) + (live.totals[1] || 0);
    var key = "tb:" + live.round + ":" + total;
    if (liveBannerKey.current === key) return;
    liveBannerKey.current = key;
    // ── HOLD MY BEER ────────────────────────────────────────────────────
    // Somebody just did something reckless. Measured over 70 real rounds:
    // a solo bid of 6+ landed 4 times (~0.6/game), a team bid of 11+ once,
    // and a team bid of 13 never - so all three tiers are wired, cheapest
    // to rarest, and the rare ones cost nothing when they never fire.
    var sts = live.seats || [];
    function teamLabel(t) {
      return sts.filter(function(x){ return x.team === t; })
                .map(function(x){ return x.name; }).join(" & ");
    }
    var hmb = null;
    for (var t = 0; t < 2 && !hmb; t++) {
      var tt = live.totals[t] || 0;
      if (tt === 13) hmb = { headline: "HOLD MY BEER", sub: teamLabel(t) + " bid ALL 13 — every book or bust" };
      else if (tt >= 11) hmb = { headline: "HOLD MY BEER", sub: teamLabel(t) + " bid " + tt + " of 13" };
    }
    if (!hmb) {
      var bold = null;
      sts.forEach(function(x) {
        var bv = (x.nil > 0) ? 0 : (x.bid || 0);
        if (bv >= 6 && (!bold || bv > bold.bid)) bold = { name: x.name, bid: bv };
      });
      if (bold) hmb = { headline: "HOLD MY BEER", sub: bold.name + " bid " + bold.bid + " solo — half the deck, alone" };
    }
    var short = 13 - total;
    // Keep the subline to ONE line or the pill grows and swallows the scores.
    var overbid = (total === 13) ? null : (short > 0
      ? { headline: "BAGS INCOMING", sub: total + " bid, 13 books — somebody's eating bags" }
      : { headline: "BID TO SET", sub: total + " bid, 13 books — somebody's going down" });
    if (!hmb && !overbid) { setLiveBanner(null); return; }
    // Both can be true at once. Show HOLD MY BEER first, then hand off - one
    // banner slot, so they queue instead of fighting over it.
    var timers = [];
    if (hmb) {
      setLiveBanner(hmb);
      if (overbid) {
        timers.push(setTimeout(function() { setLiveBanner(overbid); }, 5200));
        timers.push(setTimeout(function() { setLiveBanner(null); }, 11400));
      } else {
        timers.push(setTimeout(function() { setLiveBanner(null); }, 7000));
      }
    } else {
      setLiveBanner(overbid);
      timers.push(setTimeout(function() { setLiveBanner(null); }, 7000));
    }
    return function() { timers.forEach(function(x){ clearTimeout(x); }); };
  }, [live ? live.round : null, live ? live.complete : false, live && live.totals ? live.totals.join(",") : ""]);

  if (d && d.mode === "recap") {
    var hl = d.highlights || [];
    var cur = hl.length ? hl[reelIdx % hl.length] : null;
    var roast = cur && (cur.kind === "deadweight" || cur.kind === "nilbust" || cur.kind === "bags");
    return (
      <div style={container}>
        <style>{"@keyframes btsfade{0%{opacity:0;transform:translateY(1.6vh)}100%{opacity:1;transform:translateY(0)}}"}</style>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "2vw", color: "#c8a84e", fontVariant: "small-caps", letterSpacing: "0.3vw", fontSize: "3vh" }}>
          ♠ BidToSet <span style={{ color: "#8aaabb" }}>· Last game recap</span>
        </div>
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
          {cur && (
            <div key={reelIdx} style={{ textAlign: "center", padding: "0 4vw", animation: "btsfade 0.6s ease" }}>
              <div style={{ fontSize: "6.5vh", color: roast ? "#e0605c" : "#c8a84e", fontVariant: "small-caps", letterSpacing: "0.35vw", fontWeight: "bold", marginBottom: "2vh" }}>{cur.headline}</div>
              <div style={{ fontSize: "13vh", lineHeight: 1, color: "#f0ead8", fontWeight: "bold", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{cur.name}</div>
              <div style={{ fontSize: "3.4vh", color: "#8aaabb", fontFamily: "Arial, sans-serif", marginTop: "2.4vh" }}>{cur.sub}</div>
            </div>
          )}
        </div>
        <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: "1.4vw", height: "3.4vh" }}>
          {hl.map(function(_, i) { return <span key={i} style={{ width: "1.3vh", height: "1.3vh", borderRadius: "50%", background: i === (reelIdx % (hl.length || 1)) ? "#c8a84e" : "rgba(255,255,255,0.18)" }} />; })}
        </div>
        <div style={foot}>bidtoset.app · game recap</div>
      </div>
    );
  }

  if (d && d.mode === "empty") {
    return (
      <div style={container}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "2vw", color: "#c8a84e", fontVariant: "small-caps", letterSpacing: "0.3vw", fontSize: "3vh" }}>♠ BidToSet</div>
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", textAlign: "center", color: "#8aaabb", fontSize: "4vh", fontVariant: "small-caps", letterSpacing: "0.2vw" }}>Waiting for the next game…</div>
        <div style={foot}>bidtoset.app · live scoreboard · build {BUILD_TAG}{timer && timer.secs ? " · clock " + timer.secs + "s" : (live && (live.secs === 0 || live.secs) ? " · clock " + live.secs + "s" : "")}</div>
      </div>
    );
  }

  var done = d && d.status === "completed";
  var win = d ? d.winningTeam : null;
  var strip = d && d.strip;
  var ev = d && d.event;
  function enableAudio() {
    var a = makeBidAudio();
    if (a) { try { a.ctx.resume(); a.tick(880); } catch (_) {} setAudio(a); }
    setAudioAsked(true);
  }
  // The centre of the board: "vs" normally, the bid clock while someone is on it.
  function centerSlot() {
    // Between hands the deck is being shuffled and dealt — say so rather than
    // showing a clock nobody is racing yet.
    if (!done && live && live.armed === false) {
      return (
        <div style={{ flex: "0 0 auto", width: "17vh", textAlign: "center" }}>
          <div style={{ fontSize: "3.6vh", color: "#4a5a6a" }}>♠</div>
          <div style={{ fontSize: "1.9vh", color: "#5a6a7a", fontVariant: "small-caps", letterSpacing: "0.18vw", marginTop: "0.6vh", lineHeight: 1.25 }}>Shuffle<br />&amp; deal</div>
        </div>
      );
    }
    if (!timer || done) return <div style={{ fontSize: "3.4vh", color: "#4a5a6a", fontVariant: "small-caps" }}>vs</div>;
    var rem = Math.max(0, timer.remaining);
    var frac = Math.max(0, Math.min(1, rem / ((timer && timer.secs) || BID_SECONDS)));
    var expired = timer.remaining <= 0;
    var col = expired ? RED : (rem <= 5 ? ORANGE : GOLD);
    var R = 44, C = 2 * Math.PI * R;
    var who = null;
    if (live && live.seats) { var a2 = live.seats.filter(function(x) { return x.active; })[0]; who = a2 ? a2.name : null; }
    return (
      <div style={{ flex: "0 0 auto", position: "relative", width: "17vh", height: "17vh", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <svg viewBox="0 0 100 100" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", transform: "rotate(-90deg)", filter: expired ? "drop-shadow(0 0 1.4vh rgba(224,96,92,0.85))" : "none" }}>
          <circle cx="50" cy="50" r={R} fill="none" stroke="rgba(255,255,255,0.09)" strokeWidth="8" />
          <circle cx="50" cy="50" r={R} fill="none" stroke={col} strokeWidth="8" strokeLinecap="round"
            strokeDasharray={C} strokeDashoffset={C * (1 - frac)}
            style={{ transition: "stroke 0.25s ease" }} />
        </svg>
        <div style={{ textAlign: "center", zIndex: 1, lineHeight: 1 }}>
          <div style={{ fontSize: "6.4vh", fontWeight: "bold", color: col }}>{expired ? "0" : Math.ceil(rem)}</div>
          {who ? <div style={{ fontSize: "1.7vh", color: "#8aaabb", fontFamily: "Arial, sans-serif", marginTop: "0.6vh", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "16vh" }}>{who}</div> : null}
        </div>
      </div>
    );
  }
  var bagLimit = (d && d.bagLimit) ? d.bagLimit : 10;
  // ── Live bid strip: each player's bid as the scorekeeper enters it ────────
  function bidCell(s, k) {
    var pending = s.nil === 0 && (s.bid === null || s.bid === undefined);
    var label = s.nil === 2 ? "BLIND" : (s.nil === 1 ? "NIL" : (pending ? "·" : String(s.bid)));
    var col = s.nil === 2 ? BLUE : (s.nil === 1 ? ORANGE : (pending ? "#3d4a5a" : "#e6edf5"));
    return (
      <div key={k} style={{ flex: 1, minWidth: 0, textAlign: "center", padding: "0.5vh 0.3vw", borderRadius: "1vh",
        background: s.active ? "rgba(200,168,78,0.13)" : "transparent",
        border: "0.2vh solid " + (s.active ? "rgba(200,168,78,0.55)" : "transparent"), transition: "all 0.3s ease" }}>
        <div style={{ fontSize: "1.9vh", color: "#8aaabb", fontFamily: "Arial, sans-serif", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {s.name}
          {s.dealer ? <span style={{ fontSize: "1.4vh", padding: "0.15vh 0.5vw", borderRadius: "0.5vh", background: "rgba(200,168,78,0.15)", color: GOLD, border: "0.15vh solid rgba(200,168,78,0.45)", letterSpacing: "0.08vw", marginLeft: "0.4vw" }}>DEALER</span> : null}
        </div>
        <div style={{ fontSize: s.nil > 0 ? "2.5vh" : "3.8vh", fontWeight: "bold", color: col, lineHeight: 1.15, marginTop: "0.2vh", letterSpacing: s.nil > 0 ? "0.1vw" : "0" }}>{label}</div>
      </div>
    );
  }
  function bidGroup(t) {
    var ss = live.seats.filter(function(s) { return s.team === t; });
    return (
      <div style={{ flex: 1, maxWidth: "42vw", minWidth: 0, display: "flex", alignItems: "center", gap: "0.6vw",
        background: "rgba(255,255,255,0.03)", border: "0.2vh solid rgba(200,168,78,0.18)", borderRadius: "1.2vh", padding: "0.7vh 1vw" }}>
        {ss.map(bidCell)}
        <div style={{ borderLeft: "1px solid rgba(255,255,255,0.13)", paddingLeft: "1vw", textAlign: "center", minWidth: "6.5vw" }}>
          <div style={{ fontSize: "1.6vh", color: "#8aaabb", fontFamily: "Arial, sans-serif", letterSpacing: "0.12vw" }}>TEAM BID</div>
          <div style={{ fontSize: "3.8vh", fontWeight: "bold", color: GOLD, lineHeight: 1.15 }}>{live.totals[t]}</div>
        </div>
      </div>
    );
  }
  function panel(i) {
    var t = (d && d.teams && d.teams[i]) ? d.teams[i] : { name: "—", score: 0, bags: 0, pct: 0, toGo: null, danger: 0 };
    var isWin = win === i;
    var danger = (t.danger || 0) > 0;
    var fillPct = danger ? t.danger : (t.pct || 0);
    var fillColor = danger ? "#e0605c" : "#c8a84e";
    return (
      <div style={{ flex: 1, maxWidth: "42vw", background: isWin ? "linear-gradient(160deg,rgba(200,168,78,0.16),rgba(200,168,78,0.05))" : "rgba(255,255,255,0.03)", border: "0.3vh solid " + (isWin ? "#c8a84e" : "rgba(200,168,78,0.25)"), borderRadius: "2vh", padding: "2.2vh 2.4vw", textAlign: "center", boxShadow: isWin ? "0 0 8vh rgba(200,168,78,0.3)" : "none" }}>
        <div style={{ fontSize: "3vh", color: "#c8a84e", fontWeight: "bold", marginBottom: "0.6vh", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{t.name}</div>
        <div style={{ fontSize: "10.5vh", fontWeight: "bold", lineHeight: 1, color: isWin ? "#c8a84e" : (danger ? "#e0605c" : "#e6edf5") }}>{t.score}</div>
        <div style={{ height: "1.1vh", background: "rgba(255,255,255,0.08)", borderRadius: "99px", overflow: "hidden", margin: "1.3vh 0 0.7vh" }}>
          <div style={{ width: fillPct + "%", height: "100%", background: fillColor, borderRadius: "99px", transition: "width 0.5s ease" }} />
        </div>
        <div style={{ fontSize: "1.9vh", color: danger ? "#e0908a" : "#c8a84e", fontFamily: "Arial, sans-serif", letterSpacing: "0.05vw" }}>{done ? " " : (t.toGo != null ? (danger ? "danger zone" : (t.toGo + " to go")) : " ")}</div>
        <div style={{ fontSize: "2.1vh", color: (t.bags >= bagLimit - 1) ? "#e0605c" : ((t.bags >= bagLimit - 3) ? "#e8943a" : "#8aaabb"), marginTop: "0.8vh", fontFamily: "Arial, sans-serif" }}>{(t.bags || 0) + " / " + bagLimit + " bags"}</div>
        {bagPips(t.bags || 0, bagLimit)}
        {((t.bags || 0) >= bagLimit - 2 && (t.bags || 0) < bagLimit) ? (
          <div style={{ marginTop: "1.1vh", display: "inline-block", padding: "0.5vh 1.4vw", borderRadius: "99px",
            background: "rgba(224,92,92,0.14)", border: "0.22vh solid rgba(224,92,92,0.75)", color: "#e0605c",
            fontSize: "1.9vh", fontWeight: "bold", letterSpacing: "0.12vw", fontFamily: "Arial, sans-serif",
            animation: "btsbag 1.5s ease-in-out infinite" }}>
            {"\u26A0 BAG LADY \u00B7 " + (bagLimit - (t.bags || 0)) + " FROM " + (bagLimit * -10)}
          </div>
        ) : null}
      </div>
    );
  }
  function stripItem(label, value, first) {
    return (
      <span style={{ padding: "0 2.2vw", borderLeft: first ? "none" : "1px solid rgba(255,255,255,0.14)", whiteSpace: "nowrap" }}><span style={{ color: "#c8a84e" }}>{label}</span> · {value}</span>
    );
  }
  // Round summary — a TV-scaled copy of the phone app's ResultCard. Same line
  // wording, same colour rules, same pts (before bag penalty) and running total,
  // so the scorekeeper's phone and the TV never disagree. Mirrors the panel flex
  // geometry above (incl. a hidden "vs" spacer) so each card sits under its score.
  function summaryCell(rt, i) {
    if (!rt) return <div key={i} style={{ flex: 1, maxWidth: "42vw" }} />;
    var set = !!rt.wasSet;
    var pts = rt.pts || 0;
    var players = rt.players || [];
    return (
      <div key={i} style={{ flex: 1, maxWidth: "42vw", minWidth: 0, textAlign: "center",
        background: set ? "rgba(232,148,58,0.07)" : "rgba(255,255,255,0.02)",
        border: "0.2vh solid " + (set ? "rgba(232,148,58,0.25)" : "rgba(255,255,255,0.06)"),
        borderRadius: "1.2vh", padding: "1.2vh 1.4vw" }}>
        <div style={{ fontSize: "2.5vh", fontWeight: "bold", color: set ? ORANGE : GOLD, marginBottom: "0.7vh", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {rt.name}{set ? " (SET)" : ""}
        </div>
        {players.map(function(pl, pi) {
          var col = pl.nil === 2 ? BLUE : (pl.nil === 1 ? GOLD : "#b0c4d8");
          var what = pl.nil === 2 ? "Blind Nil" : (pl.nil === 1 ? "Nil" : ("bid " + (pl.bid == null ? 0 : pl.bid)));
          return (
            <div key={pi} style={{ fontSize: "2.1vh", color: col, fontFamily: "Arial, sans-serif", lineHeight: 1.45, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {pl.name + ": " + what + " - " + pl.tricks + " tricks" + (pl.nilFailed ? "  \u274C NIL FAILED" : "")}
            </div>
          );
        })}
        {!rt.bothNil ? <div style={{ fontSize: "2.1vh", color: "#a0b8c8", fontFamily: "Arial, sans-serif", lineHeight: 1.45 }}>{"Team bid: " + (rt.bid || 0)}</div> : null}
        {(rt.lines || []).filter(function(l) { return l.indexOf("Bag penalty") !== 0; }).map(function(l, li) {
          var bad = l.indexOf("SET") !== -1 || l.indexOf("failed") !== -1;
          var blind = l.indexOf("Blind") !== -1;
          return <div key={li} style={{ fontSize: "2.1vh", color: bad ? ORANGE : (blind ? BLUE : GREEN), fontFamily: "Arial, sans-serif", lineHeight: 1.45 }}>{l}</div>;
        })}
        <div style={{ fontSize: "4.4vh", fontWeight: "bold", lineHeight: 1.1, color: pts >= 0 ? GREEN : RED, marginTop: "0.7vh" }}>{(pts >= 0 ? "+" : "") + pts + " pts"}</div>
        {rt.bagPenalty ? <div style={{ fontSize: "1.9vh", fontWeight: "bold", color: RED, fontFamily: "Arial, sans-serif" }}>{"BAG PENALTY " + rt.bagPenalty}</div> : null}
        <div style={{ fontSize: "2vh", color: "#d0e0f0", fontFamily: "Arial, sans-serif", marginTop: "0.3vh" }}>{"Score: " + (rt.running || 0)}</div>
      </div>
    );
  }
  return (
    <div style={container}>
      <style>{"@keyframes btsbag{0%,100%{opacity:1}50%{opacity:0.45}}"}</style>
      {/* Browsers block audio until the page is interacted with, and a cast TV is
          opened from a URL with no interaction — so the first cue would be
          silently swallowed. This gate is the required first tap. */}
      {!audioAsked && (
        <div style={{ position: "fixed", inset: 0, zIndex: 100000, background: "rgba(6,9,20,0.95)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center", padding: "0 6vw" }}>
          <div style={{ fontSize: "6vh", color: "#c8a84e", fontVariant: "small-caps", letterSpacing: "0.4vw" }}>♠ Enable the bid clock</div>
          <div style={{ fontSize: "2.5vh", color: "#8aaabb", fontFamily: "Arial, sans-serif", marginTop: "2vh", maxWidth: "60vw" }}>
            {"The bid clock plays a countdown cue and a buzzer. Your TV will not play sound until you tap."}
          </div>
          <div style={{ display: "flex", gap: "2vw", marginTop: "5vh" }}>
            <button onClick={enableAudio} style={{ background: "#c8a84e", color: "#0a0e1b", border: "none", borderRadius: "1.2vh", padding: "2vh 4vw", fontSize: "2.8vh", fontWeight: "bold", cursor: "pointer", fontFamily: "Georgia, serif" }}>Turn sound on</button>
            <button onClick={function() { setAudioAsked(true); }} style={{ background: "transparent", color: "#8aaabb", border: "0.25vh solid rgba(255,255,255,0.25)", borderRadius: "1.2vh", padding: "2vh 4vw", fontSize: "2.8vh", cursor: "pointer", fontFamily: "Georgia, serif" }}>Silent</button>
          </div>
        </div>
      )}
      {/* Mute has to be reachable without a keyboard — a cast device usually only
          has a pointer or a remote. ~13 buzzers a game makes this mandatory. */}
      {audioAsked && (
        <div onClick={function() { if (!audio) { enableAudio(); } else { setMuted(!muted); } }}
          style={{ position: "absolute", top: "2vh", right: "2vw", zIndex: 99999, cursor: "pointer", fontSize: "2.6vh", color: (audio && !muted) ? "#c8a84e" : "#3d4a5a", border: "0.2vh solid " + ((audio && !muted) ? "rgba(200,168,78,0.4)" : "rgba(255,255,255,0.12)"), borderRadius: "50%", width: "5.2vh", height: "5.2vh", display: "flex", alignItems: "center", justifyContent: "center" }}
          title={(audio && !muted) ? "Sound on" : "Sound off"}>
          {(audio && !muted) ? "🔊" : "🔇"}
        </div>
      )}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "2vw", color: "#c8a84e", fontVariant: "small-caps", letterSpacing: "0.3vw", fontSize: "3vh" }}>
        ♠ BidToSet
        {d && !waiting && <span style={{ color: "#8aaabb" }}>{"· Target " + (d.winScore || 0)}</span>}
        <span style={{ color: "#8aaabb" }}>{waiting ? "· waiting for game…" : (done ? "· Final" : ("· Round " + (d.round || 0)))}</span>
        {!done && !waiting && <span style={{ color: "#6dbf8e", fontSize: "2vh", letterSpacing: "0.2vw", fontFamily: "Arial, sans-serif" }}><span style={{ display: "inline-block", width: "1.4vh", height: "1.4vh", borderRadius: "50%", background: "#6dbf8e", marginRight: "0.6vw" }} />LIVE</span>}
      </div>
      <div style={{ flex: "1.25 1 0", display: "flex", alignItems: "center", justifyContent: "center", gap: "3vw", position: "relative", minHeight: 0 }}>
        {panel(0)}
        {centerSlot()}
        {panel(1)}
        {(banner || liveBanner) && !done && (
          <div style={{ position: "absolute", left: "50%", top: "50%", transform: "translate(-50%,-50%)", background: "#c8a84e", color: "#2a1e04", padding: "2vh 4vw", borderRadius: "99px", textAlign: "center", boxShadow: "0 0 9vh rgba(200,168,78,0.55)", maxWidth: "84vw" }}>
            <div style={{ fontSize: "5.4vh", lineHeight: 1.05, fontWeight: "bold", fontVariant: "small-caps", letterSpacing: "0.25vw" }}>{"♠ " + (banner || liveBanner).headline}</div>
            <div style={{ fontSize: "2.6vh", fontFamily: "Arial, sans-serif", letterSpacing: "0.06vw", marginTop: "0.6vh" }}>{(banner || liveBanner).sub}</div>
          </div>
        )}
      </div>
      {live && !done && (
        <div style={{ display: "flex", alignItems: "stretch", justifyContent: "center", gap: "3vw", marginTop: "1.4vh" }}>
          {bidGroup(0)}
          <div style={{ fontSize: "3.4vh", visibility: "hidden" }}>vs</div>
          {bidGroup(1)}
        </div>
      )}
      <div style={{ flex: "1 1 0", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: 0, overflow: "hidden", borderTop: "1px solid rgba(255,255,255,0.06)", marginTop: "1.4vh", paddingTop: "1.6vh" }}>
        {(ev && ev.teams) ? (
          <div style={{ width: "100%" }}>
            <div style={{ textAlign: "center", fontSize: "2.1vh", color: GREEN, letterSpacing: "0.55vw", marginBottom: "1.5vh", fontFamily: "Arial, sans-serif" }}>{"ROUND " + ev.roundNumber + " RESULT"}</div>
            <div style={{ display: "flex", alignItems: "stretch", justifyContent: "center", gap: "3vw" }}>
              {summaryCell(ev.teams[0], 0)}
              <div style={{ fontSize: "3.4vh", visibility: "hidden" }}>vs</div>
              {summaryCell(ev.teams[1], 1)}
            </div>
          </div>
        ) : (
          <div style={{ color: "#3d4a5a", fontSize: "2.3vh", fontVariant: "small-caps", letterSpacing: "0.25vw" }}>{waiting ? "" : "Round in progress…"}</div>
        )}
      </div>
      <div style={{ textAlign: "center", fontSize: "3.6vh", color: "#c8a84e", height: "4.4vh", fontVariant: "small-caps", letterSpacing: "0.3vw" }}>{((win === 0 || win === 1) && d && d.teams) ? ("♠ " + d.teams[win].name + " " + winVerb(d.teams[win].name).toUpperCase()) : ""}</div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "6vh", fontFamily: "Arial, sans-serif", fontSize: "3.4vh", color: "#a8bccc", borderTop: strip ? "1px solid rgba(255,255,255,0.07)" : "none" }}>
        {strip && strip.heavyLifter && stripItem("Heavy Lifter", strip.heavyLifter.name + " " + strip.heavyLifter.pct + "%", true)}
        {strip && strip.deadWeight && stripItem("Dead Weight", strip.deadWeight.name + " " + strip.deadWeight.pct + "%", !strip.heavyLifter)}
        {strip && strip.bidLeader && stripItem("Bid leader", strip.bidLeader.name + " " + strip.bidLeader.made + "/" + strip.bidLeader.att, !(strip.heavyLifter || strip.deadWeight))}
      </div>
      <div style={foot}>bidtoset.app · live scoreboard · build {BUILD_TAG}{timer && timer.secs ? " · clock " + timer.secs + "s" : (live && (live.secs === 0 || live.secs) ? " · clock " + live.secs + "s" : "")}</div>
    </div>
  );
}

function parseRecapCode() {
  try { return new URLSearchParams(window.location.search).get("recap") || null; } catch (_) { return null; }
}

function RecapView({ code }) {
  const [d, setD] = React.useState(null);
  const [st, setSt] = React.useState("loading");
  React.useEffect(function() {
    var alive = true;
    async function load() {
      try {
        var res = await supabase.functions.invoke("game-view", { body: { c: code } });
        var j = res && res.data;
        if (!alive) return;
        if (j && !j.error) { setD(j); setSt("ready"); } else { setSt("error"); }
      } catch (_) { setSt("error"); }
    }
    load();
    return function() { alive = false; };
  }, []);
  function wrap(inner) {
    return (
      <div style={{ position: "fixed", inset: 0, background: "#0a0e1b", overflowY: "auto", color: "#c8d8e8", fontFamily: "-apple-system, Segoe UI, Roboto, sans-serif", padding: "24px 16px 48px", zIndex: 99999 }}>
        <div style={{ maxWidth: "440px", margin: "0 auto" }}>{inner}</div>
      </div>
    );
  }
  if (st === "loading") return wrap(<div style={{ textAlign: "center", color: "#8aaabb", padding: "60px 0" }}>Loading recap\u2026</div>);
  if (st === "error" || !d) return wrap(<div style={{ textAlign: "center", padding: "60px 0" }}><div style={{ fontSize: "30px", color: GOLD }}>\u2660</div><div style={{ color: "#8aaabb", marginTop: "10px" }}>This game link isn't valid anymore.</div><a href="https://bidtoset.app" style={{ display: "inline-block", marginTop: "16px", background: GOLD, color: "#0a0e1b", textDecoration: "none", fontWeight: "bold", padding: "12px 22px", borderRadius: "10px" }}>Score your own \u2192</a></div>);
  var win = d.winningTeam;
  var wTeam = (win === 0 || win === 1) ? d.teams[win] : null;
  var lTeam = (win === 0 || win === 1) ? d.teams[win === 0 ? 1 : 0] : null;
  function playerRow(p) {
    var nilStr = p.nilAtt > 0 ? (" \u00b7 nil " + p.nilSucc + "/" + p.nilAtt) : "";
    return (
      <div key={p.seat} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderTop: "1px solid rgba(255,255,255,0.05)", gap: "10px" }}>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <span style={{ fontSize: "14px", color: "#e0e8f0", fontWeight: 600 }}>{p.name}{p.isMvp && <span style={{ fontSize: "10px", padding: "2px 7px", borderRadius: "5px", marginLeft: "6px", background: "rgba(109,191,142,0.15)", color: GREEN, border: "1px solid rgba(109,191,142,0.4)" }}>MVP</span>}</span>
          <span style={{ fontSize: "11px", color: "#8aaabb" }}>{p.acc}% acc \u00b7 {p.bags} bag{p.bags === 1 ? "" : "s"}{nilStr}</span>
        </div>
        <a href={"/?claim=" + encodeURIComponent(code) + "&seat=" + p.seat + "&name=" + encodeURIComponent(p.name)} style={{ flexShrink: 0, fontSize: "11px", color: "#0a0e1b", background: GOLD, textDecoration: "none", fontWeight: 700, padding: "6px 12px", borderRadius: "7px" }}>Claim</a>
      </div>
    );
  }
  function teamBlock(ti) {
    var t = d.teams[ti];
    var ps = d.players.filter(function(p) { return p.team === ti; }).sort(function(a, b) { return a.seat - b.seat; });
    return (
      <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(200,168,78,0.18)", borderRadius: "12px", padding: "14px", marginBottom: "12px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: "14px", color: GOLD, fontWeight: "bold", marginBottom: "4px" }}><span>{t.name}</span><span>{t.score}</span></div>
        {ps.map(playerRow)}
      </div>
    );
  }
  return wrap(
    <div>
      <div style={{ textAlign: "center", fontSize: "30px", color: GOLD }}>\u2660</div>
      <div style={{ textAlign: "center", fontSize: "22px", color: GOLD, fontVariant: "small-caps", letterSpacing: "3px" }}>Game Recap</div>
      <div style={{ textAlign: "center", fontSize: "11px", color: "#6a7a8a", marginBottom: "20px" }}>bidtoset.app</div>
      {wTeam && (
        <div style={{ background: "linear-gradient(135deg,rgba(200,168,78,.14),rgba(200,168,78,.24))", border: "1px solid " + GOLD, borderRadius: "14px", padding: "18px", textAlign: "center", marginBottom: "16px" }}>
          <div style={{ fontSize: "11px", color: "#a08040", letterSpacing: "3px" }}>WINNER</div>
          <div style={{ fontSize: "22px", color: GOLD, fontWeight: "bold" }}>{wTeam.name}</div>
          <div style={{ fontSize: "34px", color: GOLD, fontWeight: "bold", lineHeight: 1.1 }}>{wTeam.score}</div>
          <div style={{ fontSize: "13px", color: "#6a7a8a", marginTop: "4px" }}>vs {lTeam.name} \u2014 {lTeam.score}</div>
          <div style={{ fontSize: "11px", color: "#4a5a6a", marginTop: "3px" }}>{d.rounds} rounds</div>
        </div>
      )}
      <div style={{ textAlign: "center", fontSize: "12px", color: "#8aaabb", margin: "2px 0 14px" }}>Is one of these you? Tap <b>Claim</b> to keep your stats.</div>
      {teamBlock(0)}
      {teamBlock(1)}
      <div style={{ textAlign: "center", marginTop: "22px" }}>
        <a href="https://bidtoset.app" style={{ display: "inline-block", background: GOLD, color: "#0a0e1b", textDecoration: "none", fontWeight: 700, fontSize: "13px", letterSpacing: "1px", padding: "12px 22px", borderRadius: "10px", textTransform: "uppercase" }}>Score your own \u2192</a>
        <div style={{ color: "#6a7a8a", fontSize: "11px", marginTop: "14px" }}>Made with \u2660 BidToSet</div>
      </div>
    </div>
  );
}

export default function App() {
  const [gs, setGs] = useState(load);
  const bidRefs = useRef({});
  const trickRefs = useRef({});
  const lastPushedRound = useRef(0);
  const startedCloudGame = useRef(null);
  const [scoreShake, setScoreShake] = useState(false);
  const [claim, setClaim] = useState(parseClaimParams);
  const [tvCode] = useState(parseTvCode);
  const [recapCode] = useState(parseRecapCode);
  const [showCast, setShowCast] = useState(false);
  const [castCode, setCastCode] = useState(null);
  const { needRefresh: [needRefresh], updateServiceWorker } = useRegisterSW({ onRegisteredSW: function(_u, r) { if (r) setInterval(function() { try { r.update(); } catch (_) {} }, 60000); } });
  useEffect(function() { if (!claim && !tvCode && !recapCode) ensureAnonSession().then(function() { ensureCastCode().then(setCastCode); }); }, []);
  // Live cloud write: create the game in the cloud the moment a new one starts.
  useEffect(function() {
    if (gs.cloudGameId && startedCloudGame.current !== gs.cloudGameId && gs.teams && gs.teams.length === 2) {
      startedCloudGame.current = gs.cloudGameId;
      lastPushedRound.current = 0;   // re-verify every round against the cloud
      var cid = gs.cloudGameId;
      cloudStartGame(cid, gs.gameId, gs.shareCode, gs.teams, rules).then(function(sc) {
        if (sc) setGs(function(s) { return s.cloudGameId === cid ? Object.assign({}, s, { shortCode: sc }) : s; });
      });
    }
  }, [gs.cloudGameId]);
  // Live cloud write: push each round as scored; delete the cloud round on undo.
  useEffect(function() {
    if (!gs.cloudGameId) return;
    var n = gs.rounds ? gs.rounds.length : 0;
    if (n > lastPushedRound.current) {
      // Push EVERY round the cloud is missing, and only advance the marker when
      // the write actually succeeded. Previously the marker moved first and the
      // push was fire-and-forget, so any failure silently dropped that round from
      // the TV score forever. Upserts are keyed on (game_id, round_number), so
      // re-pushing is harmless and lets a reload repair a game that fell behind.
      (async function () {
        for (var i = lastPushedRound.current; i < n; i++) {
          var ok = await cloudPushRound(gs.cloudGameId, gs.teams, gs.rounds[i], gs.teams);
          if (!ok) return;
          lastPushedRound.current = i + 1;
        }
      })();
    } else if (n < lastPushedRound.current) {
      var removed = lastPushedRound.current;
      lastPushedRound.current = n;
      cloudDeleteRound(gs.cloudGameId, removed);
    }
  }, [gs.rounds ? gs.rounds.length : 0]);
  // Declared HERE, above the live writer, and not further down where it used to
  // live. The writer's dependency array is evaluated during render, so naming
  // rules.bidSeconds in it while the useState sat below would throw a temporal
  // dead zone ReferenceError on every single render.
  const [rules, setRules] = useState(loadSettings);
  // Live cloud write: push bids to the TV as they're entered. Debounced to one
  // write per 400ms of quiet, and skipped entirely when nothing actually changed
  // (React re-renders far more often than the bid state does).
  const liveTimer = useRef(null);
  const lastLiveJson = useRef("");
  const bidClockKey = useRef(null);
  const bidClockAt = useRef(0);
  // A brand-new round must start the clock fresh, never inherit the last stamp.
  const lastRoundSeen = useRef(-1);
  useEffect(function() {
    if (tvCode || recapCode || claim) return;   // display routes must never write
    if (!gs.cloudGameId) return;
    var rn = gs.rounds ? gs.rounds.length : 0;
    if (lastRoundSeen.current !== rn) { lastRoundSeen.current = rn; bidClockKey.current = null; }
    var payload = null;   // null clears live_state — used once the game is won
    if (gs.winner === null && gs.seating && gs.seating.dealer && gs.teams && gs.teams.length === 2) {
      var seating = gs.seating;
      // Seat geometry matches the rest of the app: t0p0=0, t1p0=1, t0p1=2, t1p1=3.
      var seatByName = {};
      seatByName[gs.teams[0].p[0]] = 0; seatByName[gs.teams[1].p[0]] = 1;
      seatByName[gs.teams[0].p[1]] = 2; seatByName[gs.teams[1].p[1]] = 3;
      function seatOf(nm) { return (nm && seatByName[nm] !== undefined) ? seatByName[nm] : null; }
      var bids = {}, nils = {};
      [[0, "p1", 0], [1, "p1", 1], [0, "p2", 2], [1, "p2", 3]].forEach(function(x) {
        var e = (gs.entry && gs.entry[x[0]]) ? gs.entry[x[0]] : {};
        var nil = e[x[1] + "nil"] || 0;
        var raw = e[x[1] + "bid"];
        nils[x[2]] = nil;
        bids[x[2]] = (nil > 0 || raw === "" || raw === null || raw === undefined) ? null : (parseInt(raw) || 0);
      });
      var activeSeat = gs.activeBidSeat ? seatOf(seating[gs.activeBidSeat]) : null;
      // Everything the TV needs, minus the clock stamp. This doubles as the
      // change key: the clock is an INACTIVITY clock, so ANY bid activity —
      // a digit typed, a nil toggled, the turn advancing — restarts it. What
      // runs it down is nobody doing anything.
      var armed = !!gs.bidArmed;
      var core = {
        armed: armed,
        // The TV must run the SAME clock length the scorekeeper set. Absent means
        // an older scorekeeper build, so the TV falls back to its own default.
        secs: (rules.bidSeconds === 0 || rules.bidSeconds) ? rules.bidSeconds : BID_SECONDS,
        round: (gs.rounds ? gs.rounds.length : 0) + 1,
        dealerSeat: seatOf(seating[seating.dealer]),
        activeBidSeat: activeSeat,
        names: [gs.teams[0].p[0], gs.teams[1].p[0], gs.teams[0].p[1], gs.teams[1].p[1]],
        bids: bids, nils: nils,
      };
      var coreKey = JSON.stringify(core);
      if (bidClockKey.current !== coreKey) {
        bidClockKey.current = coreKey;
        bidClockAt.current = Date.now();
      }
      payload = Object.assign({}, core, { bidStartedAt: (!armed || activeSeat === null || !rules.bidSeconds) ? null : bidClockAt.current });
    }
    var js = payload ? bidClockKey.current : "null";
    if (js === lastLiveJson.current) return;
    var cid = gs.cloudGameId;
    // Broadcast is NOT debounced. A 400ms delay on a 15s clock reset is exactly
    // the lag that makes the TV buzz someone who bid on time.
    broadcastLive(cid, payload);
    if (liveTimer.current) clearTimeout(liveTimer.current);
    liveTimer.current = setTimeout(function() { lastLiveJson.current = js; cloudPushLive(cid, payload); }, 400);
    return function() { if (liveTimer.current) clearTimeout(liveTimer.current); };
    // gs.bidArmed MUST be in this list. Arming the clock is a state change with
    // no other observable effect, so without it React never re-runs the writer
    // and the countdown does not start until the first digit is typed.
    // rules.bidSeconds MUST be here too, for the same reason as gs.bidArmed.
    // Bid Clock is a LIVE setting - changeable mid-game - but without this the
    // writer never re-runs when it changes, so nothing is broadcast and nothing
    // is pushed. The TV keeps serving the previous length until the next bid
    // happens to fire the effect for some other reason. Changing the rule and
    // watching the TV therefore looked completely dead.
  }, [gs.entry, gs.seating, gs.activeBidSeat, gs.bidArmed, gs.cloudGameId, gs.winner, gs.rounds ? gs.rounds.length : 0, rules.bidSeconds]);
  const [savedFlash, setSavedFlash] = useState(false);
  const [screen, setScreen] = useState("game");
  // Keep the live cloud game's rules in sync (house-rule win-score changes mid-game) so the TV progress bar tracks the real target.
  useEffect(function() {
    if (gs.cloudGameId && startedCloudGame.current === gs.cloudGameId) cloudUpdateRules(gs.cloudGameId, rules);
  }, [rules, gs.cloudGameId]);
  const [showSummary, setShowSummary] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(!hasOnboarded());
  const [showSetup, setShowSetup] = useState(function() {
    const s = load();
    return !s.seating || !s.seating.dealer;
  });
  const [setupStep, setSetupStep] = useState(1);
  const [setupSeating, setSetupSeating] = useState(function() {
    const s = load();
    return (s.seating && s.seating.dealer) ? s.seating : { N: null, S: null, E: null, W: null, dealer: null };
  });
  const [setupPickingSeat, setSetupPickingSeat] = useState(null);
  const [setupPlayerNames, setSetupPlayerNames] = useState(["", "", "", ""]);
  const [setupTeamNames, setSetupTeamNames] = useState(["", ""]);
  const [setupReuseDeclined, setSetupReuseDeclined] = useState(false);
  const [roster, setRoster] = useState(loadRoster);
  const [rosterNew, setRosterNew] = useState("");
  const [rosterWarn, setRosterWarn] = useState(null);
  const [rosterManual, setRosterManual] = useState(false);
  const [rosterEdit, setRosterEdit] = useState(false);
  const [rosterEditing, setRosterEditing] = useState(null);   // name currently being renamed
  const [rosterEditVal, setRosterEditVal] = useState("");
  useEffect(function() {
    if (showSetup) {
      function splitTeam(t) {
        const sp = t.name.split(/\s+and\s+/i);
        if (sp.length === 2) return [sp[0].trim(), sp[1].trim()];
        return [t.p[0] || "", t.p[1] || ""];
      }
      setSetupPlayerNames(["", "", "", ""]);
      setSetupTeamNames(["", ""]);
      setSetupReuseDeclined(false);
    }
  }, [showSetup]);

  useEffect(function() {
    if (screen === "game") {
      try {
        var flag = localStorage.getItem("bidtoset_show_instructions");
        if (flag) { localStorage.removeItem("bidtoset_show_instructions"); setShowOnboarding(true); }
      } catch(_) {}
    }
  }, [screen]);
  useEffect(function() {
    save(gs);
    setSavedFlash(true);
    const t = setTimeout(function() { setSavedFlash(false); }, 1200);
    return function() { clearTimeout(t); };
  }, [gs]);

  function upd(fn) { setGs(function(s) { return fn(s); }); }

  function setField(ti, field, val) {
    upd(function(s) {
      const entry = s.entry.map(function(e, i) { return i === ti ? Object.assign({}, e, { [field]: val }) : e; });
      return Object.assign({}, s, { entry: entry });
    });
  }

  function toggleNil(ti, pnum) {
    // Detect (before the update) whether the ACTIVE player is declaring Nil for the
    // first time this turn (0 -> nonzero), so we can advance the prompt like a bid.
    const nilField = pnum === 1 ? "p1nil" : "p2nil";
    const playerName = gs.teams[ti] ? gs.teams[ti].p[pnum - 1] : null;
    const activeName = (gs.seating && gs.activeBidSeat) ? gs.seating[gs.activeBidSeat] : null;
    const wasZero = !(gs.entry[ti] && gs.entry[ti][nilField] > 0);
    upd(function(s) {
      const bidField = pnum === 1 ? "p1bid" : "p2bid";
      const entry = s.entry.map(function(e, i) {
        if (i !== ti) return e;
        const newNil = cycleNil(e[nilField]);
        return Object.assign({}, e, { [nilField]: newNil, [bidField]: newNil > 0 ? "" : e[bidField] });
      });
      return Object.assign({}, s, { entry: entry });
    });
    // Active player just declared Nil (0 -> Nil): advance prompt + focus like a bid.
    if (playerName && activeName && playerName === activeName && wasZero) {
      advanceBidSeat();
    }
  }

  function setTeamName(ti, val) {
    upd(function(s) {
      const split = splitTeamName(val);
      const teams = s.teams.map(function(t, i) {
        if (i !== ti) return t;
        var newP = [t.p[0], t.p[1]];
        if (split) {
          if (isDefaultPlayerName(t.p[0])) newP[0] = split[0];
          if (isDefaultPlayerName(t.p[1])) newP[1] = split[1];
        }
        return Object.assign({}, t, { name: val, p: newP });
      });
      return Object.assign({}, s, { teams: teams });
    });
  }

  function setPlayerName(ti, pIdx, val) {
    upd(function(s) {
      const prev = s.teams[ti] ? s.teams[ti].p[pIdx] : null;
      const teams = s.teams.map(function(t, i) {
        if (i !== ti) return t;
        const p = [t.p[0], t.p[1]];
        p[pIdx] = val;
        return Object.assign({}, t, { p: p });
      });
      // seating maps compass -> NAME. If a rename updates teams but not seating,
      // the two disagree and every name-based seat lookup silently misses that
      // player - which is how the tricks prompt started skipping the top box.
      var seating = s.seating;
      if (seating && prev && prev !== val) {
        seating = Object.assign({}, seating);
        ["N", "E", "S", "W"].forEach(function(c) { if (seating[c] === prev) seating[c] = val; });
      }
      return Object.assign({}, s, { teams: teams, seating: seating });
    });
  }

  function scoreRound() {
    const results = gs.entry.map(scoreTeam);
    upd(function(s) {
      const newTeams = s.teams.map(function(t, i) {
        let bags = t.bags + results[i].bags;
        let penalty = 0;
        while (bags >= rules.bagLimit) { bags -= rules.bagLimit; penalty += rules.bagPenalty; }
        return Object.assign({}, t, { score: t.score + results[i].pts + penalty, bags: bags });
      });

      const roundNum = s.rounds.length + 1;
      const round = {
        num: roundNum,
        entry: s.entry.map(function(e) { return Object.assign({}, e); }),
        results: results,
        after: newTeams.map(function(t) { return t.score; }),
        penalties: newTeams.map(function(t, i) { var b = s.teams[i].bags + results[i].bags; var p = 0; while (b >= rules.bagLimit) { b -= rules.bagLimit; p += rules.bagPenalty; } return p; }),
        // Bag arithmetic for THIS round, recorded at the moment it happened.
        // bagsBefore + earned = bagsRaw, which rolls over to bagsAfter.
        // Without this the cloud stamped every round in a batch with whatever the
        // live count happened to be, and the round card could not show the reset.
        bagsBefore: s.teams.map(function(t) { return t.bags; }),
        bagsEarned: results.map(function(r) { return r.bags; }),
        bagsRaw: s.teams.map(function(t, i) { return t.bags + results[i].bags; }),
        bagsAfter: newTeams.map(function(t) { return t.bags; }),
        snap: s.teams.map(function(t) { return { name: t.name, p: [t.p[0], t.p[1]] }; }),
        dealer: (s.seating && s.seating.dealer && s.seating[s.seating.dealer]) ? s.seating[s.seating.dealer] : null,
      };

      const s0 = newTeams[0].score, s1 = newTeams[1].score;
      const hasLoseScore = rules.loseScore < 0;
      let winner = null;
      if (s0 >= rules.winScore && s1 >= rules.winScore) winner = s0 >= s1 ? 0 : 1;
      else if (s0 >= rules.winScore) winner = 0;
      else if (s1 >= rules.winScore) winner = 1;
      else if (hasLoseScore && s0 <= rules.loseScore && s1 <= rules.loseScore) winner = s0 >= s1 ? 0 : 1;
      else if (hasLoseScore && s0 <= rules.loseScore) winner = 1;
      else if (hasLoseScore && s1 <= rules.loseScore) winner = 0;

      // Winner is set in state below (winner: winner). Archiving + cloud push are
      // DEFERRED to confirmFinalScore() so the scorer can undo a fat-fingered
      // deciding round first — the same one-round window every other round gets.
      // Nothing is committed here; the live game stays autosaved to STORAGE_KEY.

      const lastResult = {
        round: roundNum,
        teams: newTeams.map(function(t, i) {
          return { name: t.name, pts: results[i].pts, lines: results[i].lines, score: t.score, wasSet: results[i].wasSet };
        }),
      };

      // Dealer rotation: the deal passes clockwise each hand. Rotate the dealer and
      // reset the bid highlight to the new first bidder (seat left of dealer) so the
      // next round starts prompting the right player automatically.
      const _curDealer = (s.seating && s.seating.dealer) ? s.seating.dealer : null;
      const _nextDealer = _curDealer ? CLOCKWISE[(CLOCKWISE.indexOf(_curDealer) + 1) % 4] : null;
      const _continue = winner === null;
      return Object.assign({}, s, {
        teams: newTeams,
        rounds: s.rounds.concat([round]),
        entry: [blank(), blank()],
        lastResult: lastResult,
        winner: winner,
        seating: (_continue && _nextDealer) ? Object.assign({}, s.seating, { dealer: _nextDealer }) : s.seating,
        activeBidSeat: (_continue && _nextDealer) ? getBidOrder(_nextDealer)[0] : s.activeBidSeat,
        activeTrickSeat: null,
        // The next hand still has to be shuffled and dealt. Nothing is on the
        // clock until the scorekeeper says the cards are out.
        bidArmed: false,
      });
    });
  }


  function undoLastRound() {
    if (gs.rounds.length === 0) return;
    var conf = confirm("Undo Round " + gs.rounds.length + "? This will reverse all score changes and reopen the round for editing.");
    if (!conf) return;
    upd(function(s) {
      var lastRound = s.rounds[s.rounds.length - 1];
      var prevRounds = s.rounds.slice(0, -1);
      var prevScores = prevRounds.length > 0 ? prevRounds[prevRounds.length - 1].after : [0, 0];
      var prevBags = s.teams.map(function(t, i) {
        var currentBags = t.bags;
        var roundBags = lastRound.results[i].bags;
        var penalty = lastRound.penalties ? lastRound.penalties[i] : 0;
        var restored = currentBags - roundBags;
        if (penalty !== 0) restored += rules.bagLimit;
        return Math.max(0, restored);
      });
      var newTeams = s.teams.map(function(t, i) {
        return Object.assign({}, t, { score: prevScores[i], bags: prevBags[i] });
      });
      return Object.assign({}, s, {
        teams: newTeams,
        rounds: prevRounds,
        entry: lastRound.entry,
        lastResult: null,
        winner: null,
        bidArmed: false,
      });
    });
  }
  // Commit the game exactly once, only after the scorer confirms the final score.
  // Deferred from scoreRound so a mis-keyed deciding round can be undone first —
  // nothing was saved yet, so no duplicate history/cloud rows are possible.
  // Conceding ends the game for real: the leader is recorded as the winner and
  // the normal end-of-game path takes over (archive, cloud push, game closed).
  function concedeGame(winnerIdx) {
    if (winnerIdx !== 0 && winnerIdx !== 1) return;
    upd(function(s) { return Object.assign({}, s, { winner: winnerIdx, conceded: true }); });
  }
  function confirmFinalScore() {
    if (gs.winner === null || gs.archived) return;
    const shareCode = gs.shareCode || genShareCode();
    const gameRecord = buildGameRecord(gs, gs.winner);
    gameRecord.shareCode = shareCode;
    saveGameToHistory(gameRecord);
    pushGameToCloud(gameRecord, rules, gs.winner);
    upd(function(s) { return Object.assign({}, s, { archived: true, shareCode: shareCode }); });
    setShowSummary(true);
  }

  function confirmNewGame() {
    var msg = gs.winner !== null
      ? "Start a new game? This game is saved to History."
      : "Start a new game? This unfinished game won't be saved.";
    return confirm(msg);
  }
  function reset() {
    // History = completed games only. Completed games are saved in scoreRound()
    // when a winner is detected. Abandoned/incomplete games are intentionally not
    // archived here (they clutter History and pollute stats). When multi-game lands,
    // in-progress games get parked in a separate resumable store, not History.
    // Close the outgoing game in the cloud right away. Setup takes a minute or
    // two, and until the new game is committed there is no new row — without
    // this the TV keeps presenting the finished game as if it were live.
    if (gs.cloudGameId) cloudEndGame(gs.cloudGameId);
    try { localStorage.removeItem(STORAGE_KEY); } catch(_) {}
    setGs(newGame(gs));
    setShowSummary(false);
    const prevSeating = gs.seating && gs.seating.dealer ? gs.seating : null;
    if (prevSeating) {
      setSetupSeating(prevSeating);
    } else {
      setSetupSeating({ N: null, S: null, E: null, W: null, dealer: null });
    }
    setSetupStep(1);
    function splitName(team) {
      const split = team.name.split(/\s+and\s+/i);
      if (split.length === 2) return [split[0].trim(), split[1].trim()];
      return [team.p[0] || "", team.p[1] || ""];
    }
    const t0 = splitName(gs.teams[0]);
    const t1 = splitName(gs.teams[1]);
    setSetupPlayerNames(["", "", "", ""]);
    setSetupTeamNames(["", ""]);
    setShowSetup(true);
  }

  // ── Bid auto-advance: clockwise rotation from dealer ─────────────────────
  const CLOCKWISE = ["N", "E", "S", "W"];
  function getBidOrder(dealer) {
    if (!dealer) return [];
    const di = CLOCKWISE.indexOf(dealer);
    return [
      CLOCKWISE[(di + 1) % 4],
      CLOCKWISE[(di + 2) % 4],
      CLOCKWISE[(di + 3) % 4],
      CLOCKWISE[di],
    ];
  }
  function seatToTeamPlayer(seat, seating) {
    const name = seating[seat];
    for (let ti = 0; ti < gs.teams.length; ti++) {
      if (gs.teams[ti].p[0] === name) return { ti, pi: "p1bid" };
      if (gs.teams[ti].p[1] === name) return { ti, pi: "p2bid" };
    }
    return null;
  }
  function focusBid(seat) {
    try { var el = seat ? bidRefs.current[seat] : null; if (el && el.focus) el.focus(); } catch(_) {}
  }
  // Seats in the order the four player boxes appear on screen:
  // team0 p0, team0 p1, team1 p0, team1 p1 - top to bottom, identical every hand.
  function getTrickOrder() {
    if (!gs.seating || !gs.teams || gs.teams.length !== 2) return [];
    const compass = ["N", "E", "S", "W"];
    const want = [gs.teams[0].p[0], gs.teams[0].p[1], gs.teams[1].p[0], gs.teams[1].p[1]];
    const used = {};
    const order = want.map(function(nm) {
      const c = compass.find(function(x) { return gs.seating[x] === nm && !used[x]; }) || null;
      if (c) used[c] = true;
      return c;
    });
    // A null here means teams and seating disagree about a name. Dropping it would
    // silently shift the whole cadence up one box, so fill the hole with whichever
    // compass seat is still unclaimed and keep all four boxes in screen order.
    if (order.some(function(c) { return !c; })) {
      const spare = compass.filter(function(c) { return !used[c]; });
      for (var i = 0; i < order.length; i++) {
        if (!order[i]) { order[i] = spare.shift() || null; }
      }
    }
    return order.filter(Boolean);
  }
  // idx is the box's position on screen (0-3). The ref is keyed by compass seat,
  // and the seat prop comes from a name lookup - if that ever misses, the ref was
  // never registered and focus would silently no-op, leaving no keypad. Fall back
  // to the box's screen position so the keypad always comes up.
  function focusTrick(seat, idx) {
    var el = null;
    try { el = seat ? trickRefs.current[seat] : null; } catch(_) {}
    if (!el && typeof idx === "number") {
      try { el = document.querySelectorAll('input[placeholder="Tricks taken"]')[idx] || null; } catch(_) {}
    }
    // focus() must stay INSIDE the user gesture that called it - deferring it to a
    // timeout or rAF is what stops iOS raising the keyboard.
    try { if (el && el.focus) { el.focus(); if (el.select) el.select(); } } catch(_) {}
  }
  function advanceBidSeat() {
    if (!gs.seating || !gs.seating.dealer) return;
    const order = getBidOrder(gs.seating.dealer);
    const cur = gs.activeBidSeat;
    if (!cur) {
      upd(function(s) { return Object.assign({}, s, { activeBidSeat: order[0] }); });
      focusBid(order[0]);
      return;
    }
    const idx = order.indexOf(cur);
    const next = idx < 3 ? order[idx + 1] : null;
    // Bidding done -> move the prompt straight into trick entry on the first seat,
    // so the scorer never has to reach for the screen between phases.
    const tOrder = getTrickOrder();
    upd(function(s) { return Object.assign({}, s, { activeBidSeat: next, activeTrickSeat: next === null ? (tOrder[0] || null) : s.activeTrickSeat }); });
    if (next) focusBid(next); else focusTrick(tOrder[0], 0);
  }
  // Tricks cadence: entering a count hands the cursor to the next seat, in the
  // same clockwise order bidding uses, so the scorer can go 1 -> 2 -> 3 -> 4
  // without touching the screen between players.
  function advanceTrickSeat(fromSeat) {
    if (!gs.seating || !gs.seating.dealer || !fromSeat) return;
    const order = getTrickOrder();
    const idx = order.indexOf(fromSeat);
    if (idx === -1) return;
    const next = idx < order.length - 1 ? order[idx + 1] : null;   // stop at the last box
    upd(function(s) { return Object.assign({}, s, { activeTrickSeat: next }); });
    if (next) focusTrick(next, idx + 1);
  }
  function startRoundBidding() {
    if (!gs.seating || !gs.seating.dealer) return;
    const order = getBidOrder(gs.seating.dealer);
    upd(function(s) { return Object.assign({}, s, { activeBidSeat: order[0] }); });
  }

  // Picking from the roster drives everything downstream: the four player slots,
  // both team names, and gs.teams. Seating is cleared because it maps by NAME -
  // leaving it behind after a roster change is how the trick prompt used to land
  // on the wrong box.
  function applyPicks(next) {
    const four = [next[0] || "", next[1] || "", next[2] || "", next[3] || ""];
    setSetupPlayerNames(four);
    const t0 = four[0] && four[1] ? four[0] + " and " + four[1] : (four[0] || "Team 1");
    const t1 = four[2] && four[3] ? four[2] + " and " + four[3] : (four[2] || "Team 2");
    setSetupTeamNames([t0, t1]);
    setSetupSeating({ N: null, S: null, E: null, W: null, dealer: null });
    upd(function (st) {
      const teams = [
        Object.assign({}, st.teams[0], { name: t0, p: [four[0] || "Player 1", four[1] || "Player 2"] }),
        Object.assign({}, st.teams[1], { name: t1, p: [four[2] || "Player 3", four[3] || "Player 4"] }),
      ];
      return Object.assign({}, st, { teams: teams });
    });
  }

  // Tap a name: seat it in the first free slot, or un-seat it if already picked.
  function togglePick(name) {
    const cur = setupPlayerNames.slice();
    const at = cur.findIndex(function (x) { return String(x).toLowerCase() === String(name).toLowerCase(); });
    if (at >= 0) { cur[at] = ""; applyPicks(cur); return; }
    const free = cur.findIndex(function (x) { return !x; });
    if (free < 0) return;                      // four already picked
    cur[free] = name;
    applyPicks(cur);
  }

  function addToRoster(name) {
    const nm = String(name || "").trim();
    if (!nm) return;
    const next = rosterAdd(roster, nm);
    setRoster(next); saveRoster(next);
    setRosterNew(""); setRosterWarn(null);
    togglePick(nm);
  }

  // Rename a person everywhere at once: the pool, the four picked slots, the
  // seating map and gs.teams. Missing any one of those is how teams and seating
  // drift apart, which is the bug that sent the tricks prompt to the wrong box.
  function renameInRoster(oldName, newNameRaw) {
    const newName = String(newNameRaw || "").trim();
    if (!newName || newName === oldName) { setRosterEditing(null); return; }
    const clash = roster.some(function (x) {
      return String(x).toLowerCase() === newName.toLowerCase() && String(x) !== oldName;
    });
    if (clash) { setRosterEditing(null); return; }   // already exists - nothing to do
    const next = roster.map(function (x) { return x === oldName ? newName : x; });
    setRoster(next); saveRoster(next);
    const picks = setupPlayerNames.map(function (x) { return x === oldName ? newName : x; });
    if (picks.join("|") !== setupPlayerNames.join("|")) applyPicks(picks);
    setSetupSeating(function (prev) {
      const sn = Object.assign({}, prev);
      ["N", "E", "S", "W"].forEach(function (c) { if (sn[c] === oldName) sn[c] = newName; });
      return sn;
    });
    setRosterEditing(null); setRosterEditVal("");
  }

  function removeFromRoster(name) {
    const next = roster.filter(function (x) { return x !== name; });
    setRoster(next); saveRoster(next);
    if (setupPlayerNames.some(function (x) { return x === name; })) {
      applyPicks(setupPlayerNames.map(function (x) { return x === name ? "" : x; }));
    }
    setRosterEditing(null);
  }

  // ── Setup modal: commit seating to game state and start game ─────────────
  function commitSetup() {
    var gid = Date.now(), cloudId = genCloudId(), share = genShareCode();
    upd(function(s) {
      return Object.assign({}, s, {
        seating: setupSeating,
        activeBidSeat: getBidOrder(setupSeating.dealer)[0],
        activeTrickSeat: null,
        bidArmed: false,
        gameId: gid,           // stable id -> dedupes re-saves (local + cloud)
        cloudGameId: cloudId,  // client-owned UUID -> live cloud writes reference it
        shareCode: share,      // mint at start so the game is shareable/castable live
        archived: false,
      });
    });
    // Whatever names actually started this game join the pool, so the next game
    // is a tap instead of a retype - including names entered the manual way.
    try {
      var used = [setupSeating.N, setupSeating.E, setupSeating.S, setupSeating.W].filter(Boolean);
      var grown = used.reduce(function (acc, n) { return rosterAdd(acc, n); }, roster);
      if (grown.length !== roster.length) { setRoster(grown); saveRoster(grown); }
    } catch (_) {}
    setShowSetup(false);
  }

  // ── Setup modal: get all 4 player names from current gs ──────────────────
  function getSetupPlayers() {
    const n = setupPlayerNames;
    return [
      n[0] || gs.teams[0].p[0],
      n[1] || gs.teams[0].p[1],
      n[2] || gs.teams[1].p[0],
      n[3] || gs.teams[1].p[1],
    ];
  }

  // Combined tricks across BOTH teams must total exactly 13
  const bothTeamsTricksFilled = gs.entry.every(teamTricksFilled);
  const combinedTricks = gs.entry.reduce(function(sum, e) { return sum + teamTricks(e); }, 0);
  const anyTricksMismatch = bothTeamsTricksFilled && combinedTricks !== 13;
  const anyBidOver13 = gs.teams.some(function(_, ti) { var e = gs.entry[ti] || {}; var b1 = parseInt(e.p1bid || 0); var b2 = parseInt(e.p2bid || 0); return (b1 + b2) > 13; });
  const canScore = gs.entry.every(isReady) && !anyTricksMismatch && !anyBidOver13;
  const anyBidOne = rules.minBid >= 2 && gs.entry.some(bidOneViolation);
  const anyBlindNil = gs.entry.some(function(e) { return e.p1nil === 2 || e.p2nil === 2; });
  const anySet = gs.entry.some(pendingSet);

  const scoreBtnBg = anyBidOver13 ? RED : anyTricksMismatch ? RED : anyBidOne ? RED : anySet ? ORANGE : anyBlindNil ? BLUE : canScore ? GOLD : "rgba(255,255,255,0.12)";
  const anyWheel = gs.teams.some(function(_, ti) { var e = gs.entry[ti] || {}; var b1 = parseInt(e.p1bid || 0); var b2 = parseInt(e.p2bid || 0); return (b1 + b2) === 13; });
  const scoreBtnLabel = anyBidOver13 ? "Team bid cannot exceed 13" : anyTricksMismatch ? "Tricks must total exactly 13" : anyBidOne ? "Score Round (Override)" : anySet ? "Score Round (SET)" : anyBlindNil ? "Score Blind Nil Round" : canScore ? (anyWheel ? "HOLD MY BEER" : "Score Round") : "Fill in all fields…";

  if (recapCode) return <RecapView code={recapCode} />;
  if (tvCode) return <TVScoreboard code={tvCode} />;
  if (screen === "history") return <HistoryScreen rules={rules} onClose={function() { setScreen("game"); }} onReset={function() { setScreen("game"); reset(); }} />;
  if (screen === "settings") return <SettingsScreen onClose={function() { setScreen("game"); }} settings={rules} onSave={setRules} gameStarted={gs.rounds.length > 0} onShowInstructions={function() { setShowOnboarding(true); }} />;
  if (screen === "stats") return <StatsScreen onClose={function() { setScreen("game"); }} />;

  return (
    <div style={{ minHeight: "100vh", background: BG, backgroundImage: "radial-gradient(ellipse at 20% 50%, #0c1e3a 0%, transparent 50%), radial-gradient(ellipse at 80% 10%, #180a2a 0%, transparent 50%)", fontFamily: "Georgia, serif", color: "#e8dcc8", display: "flex", justifyContent: "center", alignItems: "flex-start" }}>
      <div style={{ width: "100%", maxWidth: "520px", display: "flex", flexDirection: "column", minHeight: "100vh", paddingBottom: "70px" }}>

        {needRefresh && (
          <div style={{ position: "fixed", top: 0, left: 0, right: 0, zIndex: 99998, background: GOLD, color: "#0a0e1b", padding: "9px 14px", display: "flex", alignItems: "center", justifyContent: "center", gap: "12px", fontFamily: "Georgia, serif", fontSize: "13px", fontWeight: "bold" }}>
            New version available
            <button onClick={function() { updateServiceWorker(true); }} style={{ background: "#0a0e1b", color: GOLD, border: "none", borderRadius: "8px", padding: "6px 14px", fontSize: "12px", fontWeight: "bold", cursor: "pointer" }}>Refresh</button>
          </div>
        )}

        {/* STICKY HEADER */}
        <div style={{ position: "sticky", top: 0, zIndex: 100, background: "rgba(9,13,27,0.97)", backdropFilter: "blur(12px)", borderBottom: "1px solid rgba(200,168,78,0.1)", padding: "10px 14px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
            <div style={{ fontSize: "9px", letterSpacing: "3px", color: "#1a2a3a" }}>SPADES</div>
            <div style={{ fontSize: "18px", letterSpacing: "4px", color: GOLD, fontVariant: "small-caps", textShadow: "0 0 20px rgba(200,168,78,0.4)" }}>Scorekeeper</div>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <div style={{ fontSize: "9px", color: savedFlash ? GREEN : "#1a2a3a", transition: "color 0.3s" }}>{savedFlash ? "saved" : "auto"}</div>
              <button onClick={function() { if (gs.rounds.length === 0 || confirmNewGame()) reset(); }} style={{ background: "rgba(200,168,78,0.1)", border: "1px solid rgba(200,168,78,0.3)", borderRadius: "6px", padding: "4px 10px", fontSize: "9px", color: GOLD, cursor: "pointer", fontFamily: "Georgia, serif", letterSpacing: "1px" }}>New Game</button>
            </div>
          </div>

          {/* Score cards */}
          <div style={{ display: "flex", gap: "10px" }}>
            {gs.teams.map(function(t, i) {
              return (
                <div key={i} style={{ flex: 1, background: "rgba(255,255,255,0.04)", border: "1px solid " + (i === 0 ? "#2d5a40" : "#5a2d2d"), borderRadius: "10px", padding: "8px", display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center" }}>
                  <div style={{ fontSize: "11px", color: GOLD, fontWeight: "bold" }}>{t.name}</div>
                  <div style={{ fontSize: "9px", color: "#a0b0c0", marginTop: "1px" }}>{t.p[0]} / {t.p[1]}</div>
                  <div style={{ fontSize: "42px", fontWeight: "bold", lineHeight: 1.1, color: t.score >= 0 ? GOLD : RED, textShadow: "0 0 16px " + (t.score >= 0 ? "rgba(200,168,78,0.4)" : "rgba(224,92,92,0.4)"), textAlign: "center", width: "100%" }}>{t.score}</div>
                  <div style={{ fontSize: "10px", color: t.bags >= Math.floor(rules.bagLimit * 0.7) ? RED : "#9aaabb", marginTop: "3px" }}>Bags: <b>{t.bags}</b>/{rules.bagLimit}</div>
                  {/* FIXED: dynamic pip count from rules.bagLimit */}
                  <div style={{ display: "flex", gap: "2px", justifyContent: "center", marginTop: "4px" }}>
                    {Array.from({ length: rules.bagLimit }).map(function(_, b) {
                      return <div key={b} style={{ width: "11px", height: "4px", borderRadius: "2px", background: b < t.bags ? (t.bags >= Math.floor(rules.bagLimit * 0.7) ? RED : GOLD) : "rgba(255,255,255,0.07)" }} />;
                    })}
                  </div>
                  <div style={{ fontSize: "9px", color: "#8aafc0", marginTop: "3px" }}>{t.score < rules.winScore ? "Need " + (rules.winScore - t.score) : "GAME POINT"}</div>
                  {t.score === 69 && <div style={{ fontSize: "10px", color: "#c8a84e", fontStyle: "italic", marginTop: "2px", opacity: 0.8 }}>Nice.</div>}
                  {t.score === 420 && <div style={{ fontSize: "12px", marginTop: "2px" }}>&#127807;</div>}
                  {t.score === 7 && <div style={{ fontSize: "9px", color: "#a0b0c0", fontStyle: "italic", marginTop: "2px" }}>Bond. James Bond.</div>}
                </div>
              );
            })}
          </div>
          <div style={{ fontSize: "9px", color: "#8aaabb", textAlign: "center", marginTop: "6px" }}>Tap any name to edit</div>
        </div>

        {/* BODY */}
        <div style={{ flex: 1, overflowY: "auto", padding: "14px", display: "flex", flexDirection: "column", gap: "12px" }}>

          {gs.winner !== null && (
            <div style={{ background: "linear-gradient(135deg, rgba(200,168,78,0.15), rgba(200,168,78,0.3))", border: "1px solid " + GOLD, borderRadius: "14px", padding: "24px", textAlign: "center" }}>
              <div style={{ fontSize: "30px", color: GOLD, fontVariant: "small-caps" }}>{gs.teams[gs.winner].name} Wins!</div>
              <div style={{ fontSize: "14px", color: "#9aaa8a", marginTop: "6px" }}>Final score: {gs.teams[gs.winner].score} pts</div>
              <div style={{ fontSize: "12px", color: "#6a7a8a", marginTop: "4px" }}>Game saved to history</div>
              <div style={{ display: "flex", gap: "10px", marginTop: "16px", justifyContent: "center" }}>
                <button onClick={function() { setShowSummary(true); }}
                  style={{ background: "rgba(200,168,78,0.2)", color: GOLD, border: "1px solid " + GOLD, borderRadius: "8px", padding: "10px 20px", fontSize: "12px", fontFamily: "Georgia, serif", letterSpacing: "2px", textTransform: "uppercase", cursor: "pointer" }}>
                  View Summary
                </button>
                <button onClick={reset} style={{ background: GOLD, color: DIM, border: "none", borderRadius: "8px", padding: "10px 20px", fontSize: "12px", fontFamily: "Georgia, serif", fontWeight: "bold", letterSpacing: "2px", textTransform: "uppercase", cursor: "pointer" }}>New Game</button>
              </div>
            </div>
          )}

          {gs.lastResult && <ResultCard result={gs.lastResult} />}

          {anyBlindNil && (
            <div style={{ borderRadius: "10px", overflow: "hidden", border: "2px solid " + BLUE, animation: "flashBlue 1.2s ease-in-out infinite" }}>
              <div style={{ background: BLUE, padding: "8px", fontSize: "11px", letterSpacing: "2px", textTransform: "uppercase", color: DIM, fontWeight: "bold", textAlign: "center" }}>BLIND NIL DECLARED</div>
              <div style={{ background: "rgba(0,191,255,0.08)", padding: "8px", fontSize: "11px", textAlign: "center", color: BLUE }}>Cards must not be seen - Success +200 - Failure -200</div>
            </div>
          )}

          {anyBidOne && !anySet && (
            <div style={{ borderRadius: "10px", overflow: "hidden", border: "2px solid " + RED, animation: "flashRed 1s ease-in-out infinite" }}>
              <div style={{ background: RED, padding: "8px", fontSize: "11px", letterSpacing: "2px", textTransform: "uppercase", color: DIM, fontWeight: "bold", textAlign: "center" }}>HOUSE RULE VIOLATION</div>
              <div style={{ background: "rgba(224,92,92,0.1)", padding: "8px", fontSize: "11px", textAlign: "center", color: RED }}>Team bid of 1 not allowed - Min bid is 2 unless NIL - Confirm with table</div>
            </div>
          )}

          {gs.winner === null && (
            <>
              <div style={{ textAlign: "center" }}>
                <div style={{ fontSize: "11px", letterSpacing: "4px", color: "#c8d8e8" }}>ROUND {gs.rounds.length + 1}</div>
                <div style={{ display: "flex", gap: "12px", justifyContent: "center", marginTop: "5px" }}>
                  <span style={{ fontSize: "10px", color: GOLD }}>NIL = +/-100</span>
                  <span style={{ fontSize: "10px", color: "#2a3a4a" }}>|</span>
                  <span style={{ fontSize: "10px", color: BLUE }}>BLIND NIL = +/-200</span>
                </div>
              </div>

              {/* The bid clock must not run while the deck is being shuffled and
                  dealt. Nothing is on the clock until the scorekeeper confirms
                  the cards are out. */}
              {gs.seating && gs.seating.dealer && !gs.bidArmed && (
                <button onClick={function() { upd(function(st) { return Object.assign({}, st, { bidArmed: true }); }); focusBid(gs.activeBidSeat); }}
                  style={{ width: "100%", background: "linear-gradient(160deg,rgba(200,168,78,0.22),rgba(200,168,78,0.08))", color: GOLD, border: "1px solid " + GOLD, borderRadius: "12px", padding: "14px", fontSize: "15px", fontWeight: "bold", letterSpacing: "1px", cursor: "pointer" }}>
                  ♠ CARDS ARE DEALT — START BIDDING
                  <div style={{ fontSize: "10px", color: "#c8d8e8", fontWeight: "normal", letterSpacing: "0.5px", marginTop: "4px" }}>
                    {(rules.bidSeconds || 0) > 0 ? "Starts the " + rules.bidSeconds + "s clock on " : "Bidding begins with "}{(gs.seating && gs.activeBidSeat) ? gs.seating[gs.activeBidSeat] : "the first bidder"}
                  </div>
                </button>
              )}

              {gs.teams.map(function(team, ti) {
                return (
                  <TeamCard key={ti + team.name + team.p[0] + team.p[1]} team={team} ti={ti} entry={gs.entry}
                    activeP1={gs.activeBidSeat && gs.seating ? gs.seating[gs.activeBidSeat] === team.p[0] : false} trickActiveP1={gs.activeTrickSeat && gs.seating ? gs.seating[gs.activeTrickSeat] === team.p[0] : false} isDealerP1={gs.seating && gs.seating.dealer ? gs.seating[gs.seating.dealer] === team.p[0] : false}
                    activeP2={gs.activeBidSeat && gs.seating ? gs.seating[gs.activeBidSeat] === team.p[1] : false} trickActiveP2={gs.activeTrickSeat && gs.seating ? gs.seating[gs.activeTrickSeat] === team.p[1] : false} isDealerP2={gs.seating && gs.seating.dealer ? gs.seating[gs.seating.dealer] === team.p[1] : false}
                    onAdvanceBid={advanceBidSeat} trickRefs={trickRefs} onAdvanceTrick={advanceTrickSeat} seatP1={gs.seating ? (["N","E","S","W"].find(function(st){ return gs.seating[st] === team.p[0]; }) || null) : null} seatP2={gs.seating ? (["N","E","S","W"].find(function(st){ return gs.seating[st] === team.p[1]; }) || null) : null} bidRefs={bidRefs}
                    onToggleNil={toggleNil} onField={setField}
                    onTeamName={function(v) { setTeamName(ti, v); }}
                    onPlayerName={setPlayerName} />
                );
              })}

              <BagLadyWarning teams={gs.teams} bagLimit={rules.bagLimit} />
              <MercyRuleBanner teams={gs.teams} onConcede={concedeGame} />

              <button onClick={function(){ if (canScore) { scoreRound(); } else { hapticPulse([50,40,50,40,70]); setScoreShake(true); setTimeout(function(){ setScoreShake(false); }, 450); } }} disabled={false} style={{
                background: scoreBtnBg, color: canScore ? DIM : "#c8d8e8", border: "none", borderRadius: "10px",
                padding: "16px", fontSize: "15px", fontFamily: "Georgia, serif",
                fontWeight: "bold", letterSpacing: "2px", textTransform: "uppercase",
                cursor: canScore ? "pointer" : "not-allowed", width: "100%",
                opacity: canScore ? 1 : 0.85,
                boxShadow: canScore ? (anySet ? "0 0 20px rgba(232,148,58,0.5)" : anyBlindNil && !anyBidOne ? "0 0 20px rgba(0,191,255,0.4)" : "0 0 14px rgba(200,168,78,0.25)") : "none",
                animation: scoreShake ? "shakeX 0.45s ease-in-out" : "none",
              }}>
                {scoreBtnLabel}
              </button>
            </>
          )}

          {gs.rounds.length > 0 && gs.winner === null && (
            <button onClick={undoLastRound} style={{ background: "transparent", color: "#8a6a5a", border: "1px solid rgba(200,120,60,0.3)", borderRadius: "8px", padding: "8px", fontSize: "9px", fontFamily: "Georgia, serif", letterSpacing: "2px", textTransform: "uppercase", cursor: "pointer", width: "100%", marginTop: "8px" }}>
              Undo Round {gs.rounds.length}
            </button>
          )}
          {gs.rounds.length > 0 && (
            <div>
              <button onClick={function() { upd(function(s) { return Object.assign({}, s, { showHistory: !s.showHistory }); }); }}
                style={{ background: "transparent", color: "#c0d0e0", border: "1px solid #4a6a8a", borderRadius: "8px", padding: "10px", fontSize: "10px", fontFamily: "Georgia, serif", letterSpacing: "2px", textTransform: "uppercase", cursor: "pointer", width: "100%" }}>
                {gs.showHistory ? "Hide" : "Show"} Round History ({gs.rounds.length})
              </button>

              {gs.showHistory && (
                <div style={{ marginTop: "10px", display: "flex", flexDirection: "column", gap: "8px" }}>
                  {gs.rounds.slice().reverse().map(function(r, idx) {
                    const snap = r.snap || gs.teams.map(function(t) { return { name: t.name, p: [t.p[0], t.p[1]] }; });
                    return (
                      <div key={idx} style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)", borderRadius: "10px", padding: "12px" }}>
                        <div style={{ fontSize: "10px", letterSpacing: "2px", color: "#a0b8c8", marginBottom: "8px", textAlign: "center" }}>ROUND {r.num}</div>
                        <div style={{ display: "flex", gap: "8px" }}>
                          {snap.map(function(nm, i) {
                            const re = r.entry[i];
                            const p1n = re.p1nil, p2n = re.p2nil;
                            const tb = calcTeamBid(re);
                            const wasSet = r.results[i].wasSet;
                            return (
                              <div key={i} style={{ flex: 1, textAlign: "center", fontSize: "11px", background: wasSet ? "rgba(232,148,58,0.07)" : "rgba(255,255,255,0.02)", border: "1px solid " + (wasSet ? "rgba(232,148,58,0.15)" : "rgba(255,255,255,0.04)"), borderRadius: "8px", padding: "8px" }}>
                                <div style={{ color: wasSet ? ORANGE : GOLD, marginBottom: "4px", fontWeight: "bold" }}>{nm.name}{wasSet ? " (SET)" : ""}</div>
                                <div style={{ color: p1n === 2 ? BLUE : p1n === 1 ? GOLD : "#b0c4d8", fontSize: "10px" }}>{nm.p[0]}: {p1n === 2 ? "Blind Nil" : p1n === 1 ? "Nil" : "bid " + re.p1bid} - {re.p1tricks} tricks{(p1n > 0 && parseInt(re.p1tricks) > 0) ? " ❌ NIL FAILED" : ""}</div>
                                <div style={{ color: p2n === 2 ? BLUE : p2n === 1 ? GOLD : "#b0c4d8", fontSize: "10px" }}>{nm.p[1]}: {p2n === 2 ? "Blind Nil" : p2n === 1 ? "Nil" : "bid " + re.p2bid} - {re.p2tricks} tricks{(p2n > 0 && parseInt(re.p2tricks) > 0) ? " ❌ NIL FAILED" : ""}</div>
                                {!(p1n > 0 && p2n > 0) && <div style={{ color: "#a0b8c8", fontSize: "10px" }}>Team bid: {tb}</div>}
                                {r.results[i].lines.map(function(l, li) {
                                  const isBad = l.indexOf("SET") !== -1 || l.indexOf("failed") !== -1;
                                  const isBlind = l.indexOf("Blind") !== -1;
                                  return <div key={li} style={{ color: isBad ? ORANGE : isBlind ? BLUE : GREEN, fontSize: "10px" }}>{l}</div>;
                                })}
                                <div style={{ color: r.results[i].pts >= 0 ? GREEN : RED, fontWeight: "bold", fontSize: "14px", marginTop: "5px" }}>{r.results[i].pts >= 0 ? "+" : ""}{r.results[i].pts} pts</div>
                                {r.penalties && r.penalties[i] !== 0 && <div style={{ color: RED, fontSize: "10px", fontWeight: "bold" }}>BAG PENALTY {r.penalties[i]}{r.bagsRaw && r.bagsAfter ? " \u00b7 " + r.bagsRaw[i] + " bags \u2192 " + r.bagsAfter[i] : ""}</div>}
                        <div style={{ color: "#d0e0f0", fontSize: "10px" }}>Score: {r.after[i]}</div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {gs.winner === null && (
            <button onClick={function() { if (gs.rounds.length === 0 || confirmNewGame()) reset(); }} style={{ background: "rgba(200,168,78,0.12)", color: GOLD, border: "1px solid rgba(200,168,78,0.4)", borderRadius: "8px", padding: "14px", fontSize: "12px", fontFamily: "Georgia, serif", letterSpacing: "2px", textTransform: "uppercase", cursor: "pointer", width: "100%", fontWeight: "bold" }}>
              Reset Game
            </button>
          )}

          <div style={{ textAlign: "center", fontSize: "9px", color: "#6a8a9a", letterSpacing: "2px", lineHeight: 2 }}>
            WIN AT {rules.winScore} - LOSE AT {rules.loseScore} - {rules.bagLimit} BAGS = {rules.bagPenalty}<br />NIL +/-100 - BLIND NIL +/-200 - MIN TEAM BID {rules.minBid}
          </div>
        </div>

      </div>

      {/* Game Setup Modal */}
      {showSetup && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.85)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center", padding: "20px" }}>
          <div style={{ background: "#0f1623", border: "1px solid rgba(200,168,78,0.3)", borderRadius: "16px", width: "100%", maxWidth: "400px", padding: "24px", display: "flex", flexDirection: "column", gap: "20px" }}>

            {/* Progress indicator */}
            <div style={{ display: "flex", justifyContent: "center", gap: "8px" }}>
              {[1,2,3].map(function(s) {
                return <div key={s} style={{ width: "32px", height: "4px", borderRadius: "2px", background: s <= setupStep ? GOLD : "rgba(255,255,255,0.15)", transition: "background 0.3s" }} />;
              })}
            </div>

            {/* Step 1: Team Names */}
            {setupStep === 1 && (
              <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                {/* ── Roster picker ─────────────────────────────────────── */}
                {!rosterManual && (
                <div style={{ background: "rgba(0,229,255,0.05)", border: "1px solid rgba(0,229,255,0.25)", borderRadius: "12px", padding: "16px", display: "flex", flexDirection: "column", gap: "12px" }}>
                  <div style={{ textAlign: "center" }}>
                    <div style={{ fontSize: "18px", color: "#00e5ff", fontWeight: "bold", fontVariant: "small-caps", letterSpacing: "2px" }}>Who's Playing?</div>
                    <div style={{ fontSize: "12px", color: "#7a9ab8", marginTop: "4px" }}>
                      {(function () {
                        const n = setupPlayerNames.filter(Boolean).length;
                        return n === 0 ? "Tap four names — first two are Team 1"
                             : n < 4   ? "Tap " + (4 - n) + " more"
                                       : "Ready";
                      })()}
                    </div>
                  </div>

                  {/* the four slots */}
                  <div style={{ display: "flex", gap: "8px" }}>
                    {[0, 1, 2, 3].map(function (i) {
                      const nm = setupPlayerNames[i];
                      const t1 = i < 2;
                      return (
                        <div key={i} onClick={function () { if (nm) togglePick(nm); }}
                          style={{ flex: 1, minWidth: 0, textAlign: "center", padding: "10px 4px", borderRadius: "8px", cursor: nm ? "pointer" : "default",
                                   background: nm ? (t1 ? "rgba(200,168,78,0.18)" : "rgba(0,191,255,0.15)") : "rgba(255,255,255,0.05)",
                                   border: "1px dashed " + (nm ? "transparent" : "rgba(255,255,255,0.2)") }}>
                          <div style={{ fontSize: "9px", color: "#7a9ab8", letterSpacing: "1px" }}>{t1 ? "TEAM 1" : "TEAM 2"}</div>
                          <div style={{ fontSize: "13px", color: nm ? "#e8dcc8" : "#4a5a6a", fontWeight: nm ? "bold" : "normal", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {nm || "—"}
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* the pool */}
                  {roster.length > 0 && (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center" }}>
                      {roster.map(function (nm) {
                        const picked = setupPlayerNames.some(function (x) { return String(x).toLowerCase() === String(nm).toLowerCase(); });
                        const full = setupPlayerNames.filter(Boolean).length >= 4;
                        if (rosterEdit && rosterEditing === nm) {
                          return (
                            <div key={nm} style={{ display: "flex", gap: "6px", alignItems: "center", width: "100%" }}>
                              <input type="text" autoFocus value={rosterEditVal}
                                onChange={function (ev) { setRosterEditVal(ev.target.value); }}
                                onKeyDown={function (ev) { if (ev.key === "Enter") renameInRoster(nm, rosterEditVal); if (ev.key === "Escape") setRosterEditing(null); }}
                                style={{ flex: 1, minWidth: 0, background: "rgba(255,255,255,0.09)", border: "1px solid " + GOLD, borderRadius: "8px", padding: "9px 12px", fontSize: "14px", color: "#e8dcc8", outline: "none" }} />
                              <button onClick={function () { renameInRoster(nm, rosterEditVal); }}
                                style={{ background: GOLD, color: "#0a0e1b", border: "none", borderRadius: "8px", padding: "9px 13px", fontSize: "13px", fontWeight: "bold", cursor: "pointer" }}>Save</button>
                              <button onClick={function () { removeFromRoster(nm); }}
                                style={{ background: "rgba(220,60,60,0.15)", color: "#e08080", border: "1px solid rgba(220,60,60,0.45)", borderRadius: "8px", padding: "9px 13px", fontSize: "13px", cursor: "pointer" }}>Remove</button>
                            </div>
                          );
                        }
                        return (
                          <button key={nm}
                            onClick={function () {
                              if (rosterEdit) { setRosterEditing(nm); setRosterEditVal(nm); }
                              else { togglePick(nm); }
                            }}
                            disabled={!rosterEdit && !picked && full}
                            style={{ background: rosterEdit ? "rgba(255,255,255,0.07)" : (picked ? GOLD : "rgba(255,255,255,0.07)"),
                                     color: rosterEdit ? "#c8d8e8" : (picked ? "#0a0e1b" : (!picked && full ? "#4a5a6a" : "#c8d8e8")),
                                     border: "1px " + (rosterEdit ? "dashed " + GOLD : "solid " + (picked ? GOLD : "rgba(255,255,255,0.18)")),
                                     borderRadius: "999px", padding: "9px 15px", fontSize: "14px",
                                     fontWeight: (!rosterEdit && picked) ? "bold" : "normal",
                                     cursor: (!rosterEdit && !picked && full) ? "not-allowed" : "pointer" }}>
                            {rosterEdit ? "\u270e " + nm : nm}
                          </button>
                        );
                      })}
                    </div>
                  )}
                  {roster.length > 0 && (
                    <div style={{ textAlign: "right", marginTop: "-4px" }}>
                      <button onClick={function () { setRosterEdit(!rosterEdit); setRosterEditing(null); }}
                        style={{ background: "transparent", color: rosterEdit ? GOLD : "#5a7a8a", border: "none", fontSize: "11px", cursor: "pointer", textDecoration: "underline", padding: "2px 0" }}>
                        {rosterEdit ? "done editing" : "edit names"}
                      </button>
                    </div>
                  )}

                  {/* add someone new */}
                  <div style={{ display: "flex", gap: "8px" }}>
                    <input type="text" placeholder="Add a player…" value={rosterNew}
                      onChange={function (ev) {
                        const v = ev.target.value;
                        setRosterNew(v);
                        setRosterWarn(nearMatch(v, roster));
                      }}
                      onKeyDown={function (ev) { if (ev.key === "Enter" && rosterNew.trim() && !rosterWarn) addToRoster(rosterNew); }}
                      style={{ flex: 1, background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.2)", borderRadius: "8px", padding: "11px 13px", fontSize: "14px", color: "#e8dcc8", outline: "none", minWidth: 0 }} />
                    <button onClick={function () { addToRoster(rosterNew); }} disabled={!rosterNew.trim()}
                      style={{ background: rosterNew.trim() ? "rgba(0,229,255,0.2)" : "rgba(255,255,255,0.06)", color: rosterNew.trim() ? "#00e5ff" : "#4a5a6a",
                               border: "1px solid " + (rosterNew.trim() ? "rgba(0,229,255,0.5)" : "rgba(255,255,255,0.15)"), borderRadius: "8px", padding: "11px 16px", fontSize: "14px", fontWeight: "bold", cursor: rosterNew.trim() ? "pointer" : "not-allowed" }}>
                      Add
                    </button>
                  </div>

                  {/* the guard that stops Mek / Mekenzie / Mekinzie */}
                  {rosterWarn && (
                    <div style={{ background: "rgba(200,168,78,0.12)", border: "1px solid rgba(200,168,78,0.4)", borderRadius: "8px", padding: "11px 13px", display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                      <span style={{ fontSize: "13px", color: GOLD, flex: 1, minWidth: "120px" }}>Did you mean <b>{rosterWarn}</b>?</span>
                      <button onClick={function () { togglePick(rosterWarn); setRosterNew(""); setRosterWarn(null); }}
                        style={{ background: GOLD, color: "#0a0e1b", border: "none", borderRadius: "6px", padding: "7px 13px", fontSize: "12px", fontWeight: "bold", cursor: "pointer" }}>
                        Yes, use {rosterWarn}
                      </button>
                      <button onClick={function () { const nm = rosterNew; setRosterWarn(null); addToRoster(nm); }}
                        style={{ background: "transparent", color: "#8aaabb", border: "1px solid rgba(255,255,255,0.2)", borderRadius: "6px", padding: "7px 13px", fontSize: "12px", cursor: "pointer" }}>
                        No, add anyway
                      </button>
                    </div>
                  )}

                  <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                    <button onClick={function () { setRosterManual(true); }}
                      style={{ background: "transparent", color: "#5a7a8a", border: "none", fontSize: "11px", cursor: "pointer", textDecoration: "underline", padding: "4px 0" }}>
                      type names instead
                    </button>
                    <div style={{ flex: 1 }} />
                    <button onClick={function () { setSetupStep(2); }} disabled={setupPlayerNames.filter(Boolean).length !== 4}
                      style={{ background: setupPlayerNames.filter(Boolean).length === 4 ? GOLD : "rgba(200,168,78,0.25)", color: "#0a0e1b", border: "none", borderRadius: "10px",
                               padding: "13px 26px", fontSize: "15px", fontWeight: "bold", letterSpacing: "1px",
                               cursor: setupPlayerNames.filter(Boolean).length === 4 ? "pointer" : "not-allowed" }}>
                      Next →
                    </button>
                  </div>
                </div>
                )}

                {rosterManual && gs.lastTable && !setupReuseDeclined && (
                  <div style={{ background: "rgba(200,168,78,0.08)", border: "1px solid rgba(200,168,78,0.3)", borderRadius: "12px", padding: "18px", display: "flex", flexDirection: "column", gap: "12px" }}>
                    <div style={{ textAlign: "center" }}>
                      <div style={{ fontSize: "18px", color: GOLD, fontWeight: "bold", fontVariant: "small-caps", letterSpacing: "2px" }}>Same Table?</div>
                      <div style={{ fontSize: "12px", color: "#c0d0e0", marginTop: "8px", fontStyle: "italic" }}>
                        {gs.lastTable.teams[0].name} vs {gs.lastTable.teams[1].name}
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: "10px", marginTop: "4px" }}>
                      <button
                        onClick={function() {
                          var lt = gs.lastTable;
                          setSetupTeamNames([lt.teams[0].name, lt.teams[1].name]);
                          setSetupPlayerNames([lt.teams[0].p[0], lt.teams[0].p[1], lt.teams[1].p[0], lt.teams[1].p[1]]);
                          setSetupSeating(Object.assign({}, lt.seating));
                          upd(function(s) {
                            var newTeams = [
                              Object.assign({}, s.teams[0], { name: lt.teams[0].name, p: [lt.teams[0].p[0], lt.teams[0].p[1]] }),
                              Object.assign({}, s.teams[1], { name: lt.teams[1].name, p: [lt.teams[1].p[0], lt.teams[1].p[1]] }),
                            ];
                            return Object.assign({}, s, { teams: newTeams });
                          });
                          setSetupStep(2);
                        }}
                        style={{ flex: 1, background: GOLD, color: "#0a0e1b", border: "none", borderRadius: "10px", padding: "14px", fontSize: "14px", fontWeight: "bold", cursor: "pointer", letterSpacing: "1px" }}>
                        Same Table
                      </button>
                      <button
                        onClick={function() {
                          setSetupReuseDeclined(true);
                          setSetupTeamNames(["", ""]);
                          setSetupPlayerNames(["", "", "", ""]);
                          setSetupSeating({ N: null, S: null, E: null, W: null, dealer: null });
                          upd(function(s) {
                            return Object.assign({}, s, {
                              teams: [
                                { name: "Team 1", score: 0, bags: 0, p: ["Player 1", "Player 2"] },
                                { name: "Team 2", score: 0, bags: 0, p: ["Player 3", "Player 4"] },
                              ],
                              seating: { N: null, S: null, E: null, W: null, dealer: null },
                            });
                          });
                        }}
                        style={{ flex: 1, background: "rgba(255,255,255,0.06)", color: "#c8d8e8", border: "1px solid rgba(255,255,255,0.2)", borderRadius: "10px", padding: "14px", fontSize: "14px", cursor: "pointer", letterSpacing: "1px" }}>
                        New Table
                      </button>
                    </div>
                  </div>
                )}
                {rosterManual && (!gs.lastTable || setupReuseDeclined) && (
                <div style={{ textAlign: "center" }}>
                  <div style={{ fontSize: "20px", color: GOLD, fontWeight: "bold", fontVariant: "small-caps", letterSpacing: "2px" }}>New Game</div>
                  <div style={{ fontSize: "12px", color: "#7a9ab8", marginTop: "6px" }}>Enter your team names to get started</div>
                </div>
                )}
                {rosterManual && (!gs.lastTable || setupReuseDeclined) && gs.teams.map(function(team, ti) {
                  return (
                    <div key={ti} style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                      <div style={{ fontSize: "11px", color: "#7a9ab8", letterSpacing: "1px", textTransform: "uppercase" }}>Team {ti + 1}</div>
                      <input
                        type="text"
                        placeholder={"e.g. " + (ti === 0 ? "Debbie and Jay" : "Donna and Kevin")}
                        value={setupTeamNames[ti] || ""}
                        onChange={function(ev) {
                          const v = ev.target.value;
                          setSetupTeamNames(function(prev) {
                            const next = prev.slice();
                            next[ti] = v;
                            return next;
                          });
                          const split = v.split(/\s+and\s+/i);
                          if (split.length === 2) {
                            setSetupPlayerNames(function(prev) {
                              const next = prev.slice();
                              next[ti * 2] = split[0].trim();
                              next[ti * 2 + 1] = split[1].trim();
                              return next;
                            });
                          } else {
                            setSetupPlayerNames(function(prev) {
                              const next = prev.slice();
                              next[ti * 2] = v;
                              next[ti * 2 + 1] = "";
                              return next;
                            });
                          }
                          upd(function(s) {
                            const teams = s.teams.map(function(t, i) {
                              if (i !== ti) return t;
                              const newP = [t.p[0], t.p[1]];
                              if (split.length === 2) {
                                newP[0] = split[0].trim();
                                newP[1] = split[1].trim();
                              }
                              return Object.assign({}, t, { name: v, p: newP });
                            });
                            return Object.assign({}, s, { teams: teams });
                          });
                        }}
                        style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(200,168,78,0.3)", borderRadius: "8px", padding: "12px 14px", fontSize: "15px", color: "#e8dcc8", outline: "none", width: "100%", boxSizing: "border-box" }}
                      />
                      <div style={{ fontSize: "10px", color: "#5a7a5a", fontStyle: "italic" }}>
                        Type "Name and Name" to auto-fill players · {setupPlayerNames[ti * 2] || "?"} / {setupPlayerNames[ti * 2 + 1] || "?"}
                      </div>
                    </div>
                  );
                })}
                {rosterManual && (!gs.lastTable || setupReuseDeclined) && (
                <button
                  onClick={function() { setSetupStep(2); }}
                  style={{ background: GOLD, color: "#0a0e1b", border: "none", borderRadius: "10px", padding: "14px", fontSize: "15px", fontWeight: "bold", cursor: "pointer", letterSpacing: "1px", marginTop: "4px" }}>
                  Next →
                </button>
                )}
              </div>
            )}

            {/* Step 2: Seating */}
            {setupStep === 2 && (
              <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                <div style={{ textAlign: "center" }}>
                  <div style={{ fontSize: "20px", color: GOLD, fontWeight: "bold", fontVariant: "small-caps", letterSpacing: "2px" }}>Seat Your Players</div>
                  <div style={{ fontSize: "12px", color: "#7a9ab8", marginTop: "6px" }}>Tap a seat, then tap a player name</div>
                </div>

                {/* Compass table diagram */}
                <div style={{ position: "relative", width: "220px", height: "220px", margin: "0 auto" }}>
                  {/* Table circle */}
                  <div style={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%,-50%)", width: "80px", height: "80px", borderRadius: "50%", background: "rgba(200,168,78,0.08)", border: "1px solid rgba(200,168,78,0.2)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <div style={{ fontSize: "24px" }}>♠</div>
                  </div>
                  {/* Seats */}
                  {[
                    { seat: "N", label: "North", top: "0px", left: "50%", transform: "translateX(-50%)" },
                    { seat: "S", label: "South", bottom: "0px", left: "50%", transform: "translateX(-50%)" },
                    { seat: "W", label: "West", top: "50%", left: "0px", transform: "translateY(-50%)" },
                    { seat: "E", label: "East", top: "50%", right: "0px", transform: "translateY(-50%)" },
                  ].map(function(pos) {
                    const assigned = setupSeating[pos.seat];
                    const isSelected = setupPickingSeat === pos.seat;
                    return (
                      <div key={pos.seat}
                        onClick={function() { setSetupPickingSeat(isSelected ? null : pos.seat); }}
                        style={{ position: "absolute", top: pos.top, bottom: pos.bottom, left: pos.left, right: pos.right, transform: pos.transform, width: "68px", height: "52px", borderRadius: "10px", border: "2px solid " + (isSelected ? "#00e5ff" : assigned ? "rgba(200,168,78,0.6)" : "rgba(255,255,255,0.15)"), background: isSelected ? "rgba(0,229,255,0.12)" : assigned ? "rgba(200,168,78,0.1)" : "rgba(255,255,255,0.04)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", cursor: "pointer", transition: "all 0.2s" }}>
                        <div style={{ fontSize: "9px", color: "#7a9ab8", letterSpacing: "1px" }}>{pos.label}</div>
                        <div style={{ fontSize: "12px", color: assigned ? GOLD : "#3a4a5a", fontWeight: "bold", marginTop: "2px" }}>{assigned || "—"}</div>
                      </div>
                    );
                  })}
                </div>

                {/* Player picker */}
                {setupPickingSeat && (
                  <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                    <div style={{ fontSize: "11px", color: "#00e5ff", textAlign: "center", letterSpacing: "1px" }}>Assign to {setupPickingSeat === "N" ? "North" : setupPickingSeat === "S" ? "South" : setupPickingSeat === "E" ? "East" : "West"}</div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", justifyContent: "center" }}>
                      {getSetupPlayers().map(function(pname) {
                        const alreadySeated = Object.values(setupSeating).includes(pname);                         const pIdx = setupPlayerNames.indexOf(pname);                         const mateIdx = pIdx >= 0 ? (pIdx % 2 === 0 ? pIdx + 1 : pIdx - 1) : -1;                         const mateName = mateIdx >= 0 ? setupPlayerNames[mateIdx] : null;                         let mateSeat = null;                         if (mateName) { ["N","S","E","W"].forEach(function(k){ if (setupSeating[k] === mateName) mateSeat = k; }); }                         const across = { N: "S", S: "N", E: "W", W: "E" };                         const blocked = mateSeat && setupPickingSeat && across[mateSeat] !== setupPickingSeat && setupSeating[setupPickingSeat] !== pname;
                        return (
                          <button key={pname}
                            disabled={(alreadySeated && setupSeating[setupPickingSeat] !== pname) || blocked}
                            onClick={function() {
                              setSetupSeating(function(prev) {
                                const next = Object.assign({}, prev);
                                // Unassign from other seat if already placed
                                Object.keys(next).forEach(function(k) { if (next[k] === pname) next[k] = null; });
                                next[setupPickingSeat] = pname;
                                return next;
                              });
                              setSetupPickingSeat(null);
                            }}
                            style={{ padding: "8px 16px", borderRadius: "8px", border: "1px solid " + (alreadySeated ? "rgba(255,255,255,0.1)" : "rgba(200,168,78,0.5)"), background: alreadySeated ? "rgba(255,255,255,0.03)" : "rgba(200,168,78,0.12)", color: alreadySeated ? "#3a4a5a" : GOLD, fontSize: "13px", cursor: alreadySeated ? "not-allowed" : "pointer" }}>
                            {pname}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                <div style={{ display: "flex", gap: "10px", marginTop: "4px" }}>
                  <button onClick={function() { setSetupStep(1); }} style={{ flex: 1, background: "rgba(255,255,255,0.06)", color: "#c8d8e8", border: "1px solid rgba(255,255,255,0.1)", borderRadius: "10px", padding: "12px", fontSize: "14px", cursor: "pointer" }}>← Back</button>
                  <button
                    disabled={!setupSeating.N || !setupSeating.S || !setupSeating.E || !setupSeating.W}
                    onClick={function() { setSetupStep(3); }}
                    style={{ flex: 2, background: (!setupSeating.N || !setupSeating.S || !setupSeating.E || !setupSeating.W) ? "rgba(200,168,78,0.3)" : GOLD, color: "#0a0e1b", border: "none", borderRadius: "10px", padding: "12px", fontSize: "14px", fontWeight: "bold", cursor: (!setupSeating.N || !setupSeating.S || !setupSeating.E || !setupSeating.W) ? "not-allowed" : "pointer" }}>
                    Next →
                  </button>
                </div>
              </div>
            )}

            {/* Step 3: Dealer */}
            {setupStep === 3 && (
              <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                <div style={{ textAlign: "center" }}>
                  <div style={{ fontSize: "20px", color: GOLD, fontWeight: "bold", fontVariant: "small-caps", letterSpacing: "2px" }}>Who Deals First?</div>
                  <div style={{ fontSize: "12px", color: "#7a9ab8", marginTop: "6px" }}>Tap the first dealer — bidding starts to their left</div>
                </div>

                {/* Dealer selection compass */}
                <div style={{ position: "relative", width: "220px", height: "220px", margin: "0 auto" }}>
                  <div style={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%,-50%)", width: "80px", height: "80px", borderRadius: "50%", background: "rgba(200,168,78,0.08)", border: "1px solid rgba(200,168,78,0.2)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <div style={{ fontSize: "24px" }}>♠</div>
                  </div>
                  {[
                    { seat: "N", top: "0px", left: "50%", transform: "translateX(-50%)" },
                    { seat: "S", bottom: "0px", left: "50%", transform: "translateX(-50%)" },
                    { seat: "W", top: "50%", left: "0px", transform: "translateY(-50%)" },
                    { seat: "E", top: "50%", right: "0px", transform: "translateY(-50%)" },
                  ].map(function(pos) {
                    const pname = setupSeating[pos.seat];
                    const isDealer = setupSeating.dealer === pos.seat;
                    return (
                      <div key={pos.seat}
                        onClick={function() { setSetupSeating(function(prev) { return Object.assign({}, prev, { dealer: pos.seat }); }); }}
                        style={{ position: "absolute", top: pos.top, bottom: pos.bottom, left: pos.left, right: pos.right, transform: pos.transform, width: "68px", height: "52px", borderRadius: "10px", border: "2px solid " + (isDealer ? GOLD : "rgba(255,255,255,0.15)"), background: isDealer ? "rgba(200,168,78,0.18)" : "rgba(255,255,255,0.04)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", cursor: "pointer", transition: "all 0.2s" }}>
                        {isDealer && <div style={{ fontSize: "9px", color: GOLD, letterSpacing: "1px", fontWeight: "bold" }}>DEALER</div>}
                        <div style={{ fontSize: "12px", color: isDealer ? GOLD : "#c8d8e8", fontWeight: "bold" }}>{pname}</div>
                      </div>
                    );
                  })}
                </div>

                {/* Bid order preview */}
                {setupSeating.dealer && (
                  <div style={{ background: "rgba(0,229,255,0.06)", border: "1px solid rgba(0,229,255,0.2)", borderRadius: "10px", padding: "12px 16px", textAlign: "center" }}>
                    <div style={{ fontSize: "10px", color: "#00e5ff", letterSpacing: "2px", marginBottom: "6px" }}>HAND 1 BID ORDER</div>
                    <div style={{ fontSize: "13px", color: "#c8d8e8" }}>
                      {getBidOrder(setupSeating.dealer).map(function(seat, i) {
                        return <span key={seat}>{i > 0 ? " → " : ""}<span style={{ color: GOLD, fontWeight: "bold" }}>{setupSeating[seat]}</span></span>;
                      })}
                    </div>
                  </div>
                )}

                <div style={{ display: "flex", gap: "10px", marginTop: "4px" }}>
                  <button onClick={function() { setSetupStep(2); }} style={{ flex: 1, background: "rgba(255,255,255,0.06)", color: "#c8d8e8", border: "1px solid rgba(255,255,255,0.1)", borderRadius: "10px", padding: "12px", fontSize: "14px", cursor: "pointer" }}>← Back</button>
                  <button
                    disabled={!setupSeating.dealer}
                    onClick={commitSetup}
                    style={{ flex: 2, background: !setupSeating.dealer ? "rgba(200,168,78,0.3)" : GOLD, color: "#0a0e1b", border: "none", borderRadius: "10px", padding: "12px", fontSize: "14px", fontWeight: "bold", cursor: !setupSeating.dealer ? "not-allowed" : "pointer" }}>
                    ♠ Start Game
                  </button>
                </div>
              </div>
            )}

          </div>
        </div>
      )}

      {showCast && (
        <div onClick={function() { setShowCast(false); }} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.9)", zIndex: 9600, display: "flex", alignItems: "center", justifyContent: "center", padding: "24px", backdropFilter: "blur(8px)" }}>
          <div onClick={function(e) { e.stopPropagation(); }} style={{ background: "#141926", border: "1px solid rgba(200,168,78,0.4)", borderRadius: "16px", padding: "26px", width: "100%", maxWidth: "340px", textAlign: "center" }}>
            <div style={{ fontSize: "11px", color: "#8aaabb", letterSpacing: "2px", textTransform: "uppercase", marginBottom: "12px" }}>Cast to TV</div>
            {castCode ? (
              <div>
                <img src={"https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=" + encodeURIComponent("https://bidtoset.app/?tv=" + castCode) + "&color=c8a84e&bgcolor=141926"} alt="QR" style={{ width: "180px", height: "180px", borderRadius: "8px" }} />
                <div style={{ fontSize: "12px", color: "#c8d8e8", margin: "14px 0 4px", lineHeight: "1.5" }}>Cast once — this link follows every game you play. Scan on the TV or cast the tab:</div>
                <div style={{ fontSize: "11px", color: GOLD, wordBreak: "break-all", marginBottom: "14px" }}>bidtoset.app/?tv={castCode}</div>
                <button onClick={function() { try { navigator.clipboard.writeText("https://bidtoset.app/?tv=" + castCode); } catch (_) {} }} style={{ background: GOLD, color: "#0a0e1b", border: "none", borderRadius: "10px", padding: "11px 20px", fontSize: "12px", fontWeight: "bold", cursor: "pointer", marginRight: "10px" }}>Copy link</button>
                <button onClick={function() { setShowCast(false); }} style={{ background: "transparent", color: "#7a8a9a", border: "none", fontSize: "12px", textDecoration: "underline", cursor: "pointer" }}>Close</button>
              </div>
            ) : (
              <div>
                <div style={{ fontSize: "13px", color: "#c8d8e8", margin: "8px 0 18px", lineHeight: "1.5" }}>Setting up your cast link…</div>
                <button onClick={function() { setShowCast(false); }} style={{ background: GOLD, color: "#0a0e1b", border: "none", borderRadius: "10px", padding: "10px 24px", fontSize: "13px", fontWeight: "bold", cursor: "pointer" }}>OK</button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Confirm Final Score gate — one-round correction window on the deciding round */}
      {claim && <ClaimFlow code={claim.code} seat={claim.seat} name={claim.name} onClose={function() { setClaim(null); try { window.history.replaceState({}, "", window.location.pathname); } catch (_) {} }} />}

      {gs.winner !== null && !gs.archived && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.88)", zIndex: 350, display: "flex", alignItems: "center", justifyContent: "center", padding: "24px", backdropFilter: "blur(8px)" }}>
          <div style={{ background: "#141926", border: "1px solid rgba(200,168,78,0.4)", borderRadius: "16px", padding: "24px", width: "100%", maxWidth: "360px", boxShadow: "0 0 40px rgba(0,0,0,0.6)" }}>
            <div style={{ fontSize: "10px", color: "#8aaabb", letterSpacing: "3px", textAlign: "center", textTransform: "uppercase", marginBottom: "6px" }}>Confirm Final Score</div>
            <div style={{ fontSize: "18px", color: GOLD, fontWeight: "bold", textAlign: "center", marginBottom: "16px", fontVariant: "small-caps" }}>{gs.teams[gs.winner].name + " " + winVerb(gs.teams[gs.winner].name)}</div>
            {gs.teams.map(function(t, i) {
              return (
                <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 12px", borderRadius: "10px", marginBottom: "8px", background: i === gs.winner ? "rgba(200,168,78,0.14)" : "rgba(255,255,255,0.04)", border: "1px solid " + (i === gs.winner ? "rgba(200,168,78,0.4)" : "rgba(255,255,255,0.08)") }}>
                  <span style={{ fontSize: "13px", color: i === gs.winner ? GOLD : "#c8d8e8", fontWeight: "bold" }}>{t.name}</span>
                  <span style={{ fontSize: "18px", color: i === gs.winner ? GOLD : "#c8d8e8", fontWeight: "bold" }}>{t.score}</span>
                </div>
              );
            })}
            <div style={{ fontSize: "11px", color: "#8aaabb", textAlign: "center", margin: "12px 0 16px", lineHeight: "1.4" }}>Check the score. Undo the last round to fix an error — once you confirm, the game is saved.</div>
            <div style={{ display: "flex", gap: "10px" }}>
              <button onClick={undoLastRound} style={{ flex: "1", background: "transparent", color: "#c89a6a", border: "1px solid rgba(200,120,60,0.5)", borderRadius: "10px", padding: "13px", fontSize: "12px", fontFamily: "Georgia, serif", letterSpacing: "1px", textTransform: "uppercase", cursor: "pointer" }}>Undo Round {gs.rounds.length}</button>
              <button onClick={confirmFinalScore} style={{ flex: "1.4", background: GOLD, color: "#0a0e1b", border: "none", borderRadius: "10px", padding: "13px", fontSize: "13px", fontWeight: "bold", letterSpacing: "1px", textTransform: "uppercase", cursor: "pointer" }}>♠ Confirm</button>
            </div>
          </div>
        </div>
      )}

      {/* Game Summary Card Modal */}
      {showSummary && gs.winner !== null && (
        <GameSummaryCard gs={gs} rules={rules} onDismiss={function() { setShowSummary(false); }} />
      )}

      {/* Onboarding Carousel */}
      {showOnboarding && (
        <OnboardingOverlay onDismiss={function() { setShowOnboarding(false); }} />
      )}

      {/* Bottom Navigation Bar */}
      <div style={{ position: "fixed", bottom: 0, left: 0, right: 0, display: "flex", gap: "0", background: "rgba(35,30,40,0.98)", borderTop: "2px solid rgba(200,168,78,0.7)", padding: "6px 12px", paddingBottom: "env(safe-area-inset-bottom, 8px)", zIndex: 9000, backdropFilter: "blur(10px)" }}>
        <button onClick={function() { setShowSummary(false); setScreen("history"); }} style={{ flex: 1, background: "transparent", border: "none", padding: "8px 4px", fontSize: "9px", color: screen === "history" ? GOLD : "#a0b0c0", cursor: "pointer", fontFamily: "Georgia, serif", letterSpacing: "1px", textTransform: "uppercase", display: "flex", flexDirection: "column", alignItems: "center", gap: "4px" }}><span style={{ fontSize: "30px" }}>📋</span>History</button>
        <button onClick={function() { setShowSummary(false); setScreen("stats"); }} style={{ flex: 1, background: "transparent", border: "none", padding: "8px 4px", fontSize: "9px", color: screen === "stats" ? GOLD : "#a0b0c0", cursor: "pointer", fontFamily: "Georgia, serif", letterSpacing: "1px", textTransform: "uppercase", display: "flex", flexDirection: "column", alignItems: "center", gap: "4px" }}><span style={{ fontSize: "30px" }}>📊</span>Stats</button>
        <button onClick={function() { setShowCast(true); }} style={{ flex: 1, background: "transparent", border: "none", padding: "8px 4px", fontSize: "9px", color: "#a0b0c0", cursor: "pointer", fontFamily: "Georgia, serif", letterSpacing: "1px", textTransform: "uppercase", display: "flex", flexDirection: "column", alignItems: "center", gap: "4px" }}><span style={{ fontSize: "30px" }}>📺</span>Cast</button>
        <button onClick={function() { setShowSummary(false); setScreen("settings"); }} style={{ flex: 1, background: "transparent", border: "none", padding: "8px 4px", fontSize: "9px", color: screen === "settings" ? GOLD : "#a0b0c0", cursor: "pointer", fontFamily: "Georgia, serif", letterSpacing: "1px", textTransform: "uppercase", display: "flex", flexDirection: "column", alignItems: "center", gap: "4px" }}><span style={{ fontSize: "30px" }}>⚙</span>Rules</button>
      </div>      <style>{`
        @keyframes fadeIn { from { opacity: 0; transform: scale(0.95); } to { opacity: 1; transform: scale(1); } }
        @keyframes flashOrange { 0%,100% { opacity:1 } 50% { opacity:0.7 } }
        @keyframes flashBlue { 0%,100% { opacity:1 } 50% { opacity:0.7 } }
        @keyframes flashRed { 0%,100% { opacity:1 } 50% { opacity:0.7 } }
        @keyframes shakeX { 0%,100%{transform:translateX(0)} 15%{transform:translateX(-9px)} 30%{transform:translateX(9px)} 45%{transform:translateX(-7px)} 60%{transform:translateX(7px)} 75%{transform:translateX(-4px)} 90%{transform:translateX(4px)} }
        input:focus { outline: none !important; border-color: #c8a84e !important; }
        input::placeholder { color: #a0b4c8; }
        input::-webkit-outer-spin-button, input::-webkit-inner-spin-button { -webkit-appearance: none; }
      `}</style>
    </div>
  );
}
