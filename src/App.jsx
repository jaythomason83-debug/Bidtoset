import React, { useState, useEffect, useRef } from "react";

const WINNING_SCORE = 500;
const LOSING_SCORE = -200;
const BAG_LIMIT = 10;
const BAG_PENALTY = -100;
const STORAGE_KEY = "spades_v13";
const HISTORY_KEY = "spades_history_v1";
const SETTINGS_KEY = "spades_settings_v1";

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
    history.unshift(gameData);
    if (history.length > 50) history.pop();
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  } catch (_) {}
}

function buildGameRecord(gs, winner) {
  const now = new Date();
  return {
    id: now.getTime(),
    date: now.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }),
    time: now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }),
    teams: gs.teams.map(function(t) { return { name: t.name, score: t.score, bags: t.bags, p: [t.p[0], t.p[1]] }; }),
    winner: winner !== null ? gs.teams[winner].name : null,
    rounds: gs.rounds,
    totalRounds: gs.rounds.length,
  };
}

// ─── Player Analytics Engine ──────────────────────────────────────────────────

function buildPlayerStats(history) {
  const players = {};

  function getPlayer(name) {
    if (!players[name]) {
      players[name] = {
        name: name,
        games: 0, wins: 0,
        rounds: 0,
        totalBid: 0, totalTricks: 0,
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
    game.teams.forEach(function(team, ti) {
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

          var rawT1 = parseInt(entry.p1tricks) || 0;
          var rawT2 = parseInt(entry.p2tricks) || 0;
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
    p.isSandbagger = p.sandbagRate >= 30 && biddingRounds >= 5;
    p.deadWeightIndex = p.teamTotalTricks > 0 ? Math.round((p.totalTricks / p.teamTotalTricks) * 100) : null;
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
      playerMap[name] = { name: name, totalBid: 0, totalTricks: 0, madeBid: 0, overBid: 0, underBid: 0, bags: 0, pts: 0, rounds: 0, teamName: "" };
    }
    return playerMap[name];
  }

  gs.teams.forEach(function(team, ti) {
    var p1 = getP(team.p[0]); p1.teamName = team.name;
    var p2 = getP(team.p[1]); p2.teamName = team.name;

    gs.rounds.forEach(function(round) {
      var entry = round.entry[ti];
      var result = round.results[ti];
      if (!entry || !result) return;

      // P1
      p1.rounds++;
      p1.pts += result.pts / 2; // approximate split
      if (entry.p1nil === 0) {
        var b1 = parseInt(entry.p1bid) || 0;
        var t1 = parseInt(entry.p1tricks) || 0;
        p1.totalBid += b1; p1.totalTricks += t1;
        if (t1 === b1) p1.madeBid++;
        else if (t1 > b1) { p1.overBid++; p1.bags += (t1 - b1); }
        else p1.underBid++;
      }

      // P2
      p2.rounds++;
      p2.pts += result.pts / 2;
      if (entry.p2nil === 0) {
        var b2 = parseInt(entry.p2bid) || 0;
        var t2 = parseInt(entry.p2tricks) || 0;
        p2.totalBid += b2; p2.totalTricks += t2;
        if (t2 === b2) p2.madeBid++;
        else if (t2 > b2) { p2.overBid++; p2.bags += (t2 - b2); }
        else p2.underBid++;
      }
    });
  });

  const allPlayers = Object.values(playerMap);

  // Compute accuracy & normalized pts for MVP weighting
  const maxPts = Math.max(...allPlayers.map(function(p) { return p.pts; }), 1);
  allPlayers.forEach(function(p) {
    var br = p.madeBid + p.overBid + p.underBid;
    p.bidAccuracy = br > 0 ? Math.round((p.madeBid / br) * 100) : 0;
    p.sandbagRate = br > 0 ? Math.round((p.overBid / br) * 100) : 0;
    var normalizedPts = (p.pts / maxPts) * 100;
    // 65% bid accuracy, 35% points contribution
    p.mvpScore = (p.bidAccuracy * 0.65) + (normalizedPts * 0.35);
  });

  // MVP = highest weighted score
  const mvp = allPlayers.reduce(function(best, p) { return p.mvpScore > best.mvpScore ? p : best; }, allPlayers[0]);

  // Cross-game sandbagger from history
  const history = loadHistory();
  const crossGameStats = buildPlayerStats(history);
  const sandbaggers = crossGameStats.filter(function(p) { return p.isSandbagger; });

  // Most bags this game (for game-level callout)
  const mostBagsPlayer = allPlayers.reduce(function(worst, p) { return p.bags > worst.bags ? p : worst; }, allPlayers[0]);

  return { allPlayers, mvp, sandbaggers, mostBagsPlayer };
}

// ─── Settings ─────────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS = {
  winScore: 500,
  loseScore: -200,
  bagLimit: 10,
  bagPenalty: -100,
  minBid: 2,
};

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? Object.assign({}, DEFAULT_SETTINGS, JSON.parse(raw)) : Object.assign({}, DEFAULT_SETTINGS);
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

  let pts = 0, bags = 0, lines = [], wasSet = false;

  [[p1nil, e.p1nil, t1], [p2nil, e.p2nil, t2]].forEach(function(arr) {
    const isNil = arr[0], state = arr[1], tricks = arr[2];
    if (!isNil) return;
    const blind = state === 2;
    const val = blind ? 200 : 100;
    if (tricks === 0) { pts += val; lines.push((blind ? "Blind Nil" : "Nil") + " made +" + val); }
    else { pts -= val; bags += tricks; lines.push((blind ? "Blind Nil" : "Nil") + " failed -" + val); }
  });

  if (!bothNil) {
    const bidTricks = (!p1nil ? t1 : 0) + (!p2nil ? t2 : 0);
    if (bidTricks >= teamBid) {
      const over = bidTricks - teamBid;
      pts += teamBid * 10 + over;
      bags += over;
      lines.push(over === 0 ? "Bid " + teamBid + " made" : "Bid " + teamBid + " +" + over + " bag" + (over !== 1 ? "s" : ""));
    } else {
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

function newGame() {
  return {
    teams: [
      { name: "Team 1", score: 0, bags: 0, p: ["Player 1", "Player 2"] },
      { name: "Team 2", score: 0, bags: 0, p: ["Player 3", "Player 4"] },
    ],
    entry: [blank(), blank()],
    rounds: [], lastResult: null, winner: null, showHistory: false,
  };
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      s.entry = [blank(), blank()];
      s.lastResult = null;
      s.showHistory = false;
      return s;
    }
  } catch (_) {}
  return newGame();
}

function save(s) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(
      Object.assign({}, s, { entry: [], lastResult: null, showHistory: false })
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

function PlayerRow({ name, onNameChange, nilState, bid, tricks, onToggleNil, onBid, onTricks }) {
  const ns = nilBtnStyle(nilState);
  const isNil = nilState > 0;

  return (
    <div style={{ background: "rgba(0,0,0,0.2)", border: "1px solid " + (nilState === 2 ? "rgba(0,191,255,0.2)" : nilState === 1 ? "rgba(200,168,78,0.15)" : "rgba(255,255,255,0.05)"), borderRadius: "10px", padding: "11px 12px", display: "flex", flexDirection: "column", gap: "8px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", minHeight: "22px" }}>
        <EditableName value={name} onChange={onNameChange} style={{ fontSize: "12px", color: "#c8d8e8", letterSpacing: "1px", flex: 1 }} />
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
            <input type="number" min="0" max="13" placeholder="Bid" value={bid}
              onChange={function(ev) { onBid(ev.target.value); }}
              style={iStyle({ borderColor: "rgba(200,168,78,0.85)", background: "rgba(200,168,78,0.14)", color: bid === "" ? "#8a9aaa" : "#e8dcc8" })} />
          )}
        </div>
        <button onClick={onToggleNil} style={Object.assign({ flex: 1, minWidth: 0, borderRadius: "8px", padding: "12px 6px", fontSize: "10px", fontFamily: "Georgia, serif", letterSpacing: "1px", textTransform: "uppercase", cursor: "pointer", fontWeight: "bold" }, ns)}>
          {nilLabel(nilState)}
        </button>
      </div>

      <input type="number" min="0" max="13" placeholder="Tricks taken" value={tricks}
        onChange={function(ev) { onTricks(ev.target.value); }}
        style={iStyle({ borderColor: nilState === 2 ? "rgba(0,191,255,0.55)" : nilState === 1 ? "rgba(200,168,78,0.55)" : "rgba(255,255,255,0.35)", color: tricks === "" ? "#8a9aaa" : "#e8dcc8" })} />
    </div>
  );
}

// ─── Team Card ────────────────────────────────────────────────────────────────

function TeamCard({ team, ti, entry, onToggleNil, onField, onTeamName, onPlayerName }) {
  const e = entry[ti];
  const bothNil = e.p1nil > 0 && e.p2nil > 0;
  const total = calcTeamBid(e);
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
          <div style={{ fontSize: "28px", fontWeight: "bold", color: setAlert ? ORANGE : warn ? RED : hasBids ? GOLD : "#3a4a5a" }}>{hasBids ? total : "-"}</div>
          {warn && !setAlert && <div style={{ fontSize: "10px", color: RED, fontWeight: "bold" }}>MIN 2</div>}
          {setAlert && <div style={{ fontSize: "10px", color: ORANGE, fontWeight: "bold" }}>SET!</div>}
        </div>
      )}

      {setAlert && (
        <div style={{ background: ORANGE, color: DIM, borderRadius: "8px", padding: "10px 14px", textAlign: "center", fontWeight: "bold", fontSize: "13px", letterSpacing: "1px", animation: "flashOrange 1s ease-in-out infinite" }}>
          SET - bid {total}, took {tricksTaken} - minus {total * 10} pts
        </div>
      )}

      {bothNil && (
        <div style={{ background: "rgba(200,168,78,0.05)", border: "1px solid rgba(200,168,78,0.1)", borderRadius: "8px", padding: "8px 12px", textAlign: "center", fontSize: "11px", color: "#4a5a6a" }}>
          Both nil - no team bid
        </div>
      )}

      <div style={{ borderTop: "1px solid rgba(255,255,255,0.05)" }} />

      <PlayerRow name={team.p[0]} onNameChange={function(v) { onPlayerName(ti, 0, v); }} nilState={e.p1nil} bid={e.p1bid} tricks={e.p1tricks} onToggleNil={function() { onToggleNil(ti, 1); }} onBid={function(v) { onField(ti, "p1bid", v); }} onTricks={function(v) { onField(ti, "p1tricks", v); }} />
      <PlayerRow name={team.p[1]} onNameChange={function(v) { onPlayerName(ti, 1, v); }} nilState={e.p2nil} bid={e.p2bid} tricks={e.p2tricks} onToggleNil={function() { onToggleNil(ti, 2); }} onBid={function(v) { onField(ti, "p2bid", v); }} onTricks={function(v) { onField(ti, "p2tricks", v); }} />

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

function GameSummaryCard({ gs, rules, onDismiss }) {
  const summary = buildGameSummary(gs, rules);
  const winner = gs.winner !== null ? gs.teams[gs.winner] : null;
  const loser = gs.winner !== null ? gs.teams[gs.winner === 0 ? 1 : 0] : null;

  function copyToClipboard() {
    const lines = [
      "♠ BidToSet Game Summary ♠",
      "─────────────────────────",
      winner ? (winner.name + " WINS " + winner.score + " - " + loser.score) : "Game Over",
      gs.rounds.length + " rounds played",
      "",
      "🏆 MVP: " + summary.mvp.name + " (" + summary.mvp.bidAccuracy + "% bid accuracy)",
      summary.mostBagsPlayer.bags > 0 ? ("🎒 Most Bags: " + summary.mostBagsPlayer.name + " (" + summary.mostBagsPlayer.bags + " bags)") : "",
      summary.sandbaggers.length > 0 ? ("⚠️ Sandbagger Alert: " + summary.sandbaggers.map(function(p) { return p.name; }).join(", ")) : "",
      "",
      "bidtoset.netlify.app",
    ].filter(Boolean).join("\n");

    try {
      navigator.clipboard.writeText(lines);
    } catch (_) {}
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.85)", zIndex: 300, display: "flex", alignItems: "center", justifyContent: "center", padding: "20px", backdropFilter: "blur(8px)", animation: "fadeIn 0.4s ease-out" }}
      onClick={onDismiss}>
      <div onClick={function(e) { e.stopPropagation(); }}
        style={{ background: "linear-gradient(145deg, #0d1528, #090d1b)", border: "1px solid " + GOLD, borderRadius: "18px", padding: "24px", width: "100%", maxWidth: "400px", boxShadow: "0 0 60px rgba(200,168,78,0.3)" }}>

        {/* Header */}
        <div style={{ textAlign: "center", marginBottom: "20px" }}>
          <div style={{ fontSize: "32px", lineHeight: 1, marginBottom: "6px" }}>♠</div>
          <div style={{ fontSize: "20px", color: GOLD, fontVariant: "small-caps", letterSpacing: "3px" }}>Game Summary</div>
          <div style={{ fontSize: "11px", color: "#6a7a8a", marginTop: "4px" }}>bidtoset.netlify.app</div>
        </div>

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
            <div style={{ fontSize: "10px", color: "#4a8a6a", letterSpacing: "2px" }}>MVP — 65% BID ACCURACY · 35% CONTRIBUTION</div>
            <div style={{ fontSize: "16px", color: GREEN, fontWeight: "bold" }}>{summary.mvp.name}</div>
            <div style={{ fontSize: "11px", color: "#6a9a7a" }}>{summary.mvp.bidAccuracy}% bid accuracy · {summary.mvp.teamName}</div>
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

        {/* Actions */}
        <div style={{ display: "flex", gap: "10px" }}>
          <button onClick={copyToClipboard}
            style={{ flex: 1, background: GOLD, color: DIM, border: "none", borderRadius: "10px", padding: "14px", fontSize: "12px", fontFamily: "Georgia, serif", fontWeight: "bold", letterSpacing: "2px", textTransform: "uppercase", cursor: "pointer" }}>
            Copy Summary
          </button>
          <button onClick={onDismiss}
            style={{ flex: 1, background: "transparent", color: "#c0d0e0", border: "1px solid rgba(255,255,255,0.15)", borderRadius: "10px", padding: "14px", fontSize: "12px", fontFamily: "Georgia, serif", letterSpacing: "2px", textTransform: "uppercase", cursor: "pointer" }}>
            Dismiss
          </button>
        </div>

        <div style={{ textAlign: "center", fontSize: "9px", color: "#2a3a4a", marginTop: "12px" }}>Tap outside to dismiss</div>
      </div>
    </div>
  );
}

// ─── History Screen ───────────────────────────────────────────────────────────

function HistoryScreen({ onClose }) {
  const [history, setHistory] = useState(loadHistory);
  const [selected, setSelected] = useState(null);

  function clearHistory() {
    if (window.confirm("Clear all game history? This cannot be undone.")) {
      localStorage.removeItem(HISTORY_KEY);
      setHistory([]);
    }
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
          <button onClick={clearHistory} style={{ background: "transparent", border: "1px solid rgba(224,92,92,0.3)", borderRadius: "8px", padding: "8px 14px", color: RED, cursor: "pointer", fontFamily: "Georgia, serif", fontSize: "10px" }}>Clear All</button>
        </div>

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
                  style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(200,168,78,0.15)", borderRadius: "12px", padding: "14px", cursor: "pointer" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
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
                    <div style={{ fontSize: "16px", color: GOLD, fontWeight: "bold" }}>{p.name}</div>
                    <div style={{ display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
                      {p.isHeavyLifter && <div style={{ fontSize: "10px", padding: "3px 8px", borderRadius: "4px", background: "rgba(109,191,142,0.2)", color: GREEN, fontWeight: "bold", letterSpacing: "1px" }}>HEAVY LIFTER</div>}
                      {p.isDeadWeight && <div style={{ fontSize: "10px", padding: "3px 8px", borderRadius: "4px", background: "rgba(224,92,92,0.2)", color: RED, fontWeight: "bold", letterSpacing: "1px" }}>DEAD WEIGHT</div>}
                      {p.isSandbagger && <div style={{ fontSize: "10px", padding: "3px 8px", borderRadius: "4px", background: "rgba(232,148,58,0.2)", color: ORANGE, fontWeight: "bold", letterSpacing: "1px" }}>SANDBAGGER</div>}
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
                    </div>
                  )}

                  {p.nilAttempts > 0 && <StatBar label={"Nil (" + p.nilAttempts + " attempts)"} value={p.nilRate} suffix="% success" color={p.nilRate >= 70 ? GREEN : p.nilRate >= 40 ? GOLD : RED} />}
                  {p.blindNilAttempts > 0 && <StatBar label={"Blind Nil (" + p.blindNilAttempts + " attempts)"} value={p.blindNilRate} suffix="% success" color={p.blindNilRate >= 50 ? BLUE : RED} />}

                  {p.isSandbagger && (
                    <div style={{ marginTop: "10px", background: "rgba(232,148,58,0.1)", border: "1px solid rgba(232,148,58,0.3)", borderRadius: "8px", padding: "8px 10px", fontSize: "11px", color: ORANGE, textAlign: "center" }}>
                      Sandbagged {p.overBid} of {p.madeBid + p.overBid + p.underBid} rounds - consistently overbidding
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

function SettingsScreen({ onClose, settings, onSave, gameStarted }) {
  const [draft, setDraft] = React.useState(Object.assign({}, settings));

  function Option({ label, field, options }) {
    return (
      <div style={{ marginBottom: "16px" }}>
        <div style={{ fontSize: "11px", color: "#8aaabb", letterSpacing: "2px", textTransform: "uppercase", marginBottom: "8px" }}>{label}</div>
        <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
          {options.map(function(opt) {
            const active = draft[field] === opt.value;
            return (
              <button key={opt.value} onClick={function() { if (!gameStarted) setDraft(function(d) { return Object.assign({}, d, { [field]: opt.value }); }); }}
                style={{ flex: 1, minWidth: "60px", padding: "10px 6px", borderRadius: "8px", fontFamily: "Georgia, serif", fontSize: "12px", cursor: gameStarted ? "not-allowed" : "pointer", fontWeight: active ? "bold" : "normal",
                  background: active ? "rgba(200,168,78,0.2)" : "rgba(255,255,255,0.04)",
                  border: "1px solid " + (active ? GOLD : "rgba(255,255,255,0.12)"),
                  color: active ? GOLD : gameStarted ? "#3a4a5a" : "#c0d0e0",
                  opacity: gameStarted && !active ? 0.4 : 1,
                }}>
                {opt.label}
              </button>
            );
          })}
        </div>
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

        {/* Show Instructions toggle */}
        <button onClick={function() {
          try { localStorage.removeItem("bidtoset_onboarded_v1"); } catch(_) {}
          onClose();
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
      display: "flex", alignItems: "center", justifyContent: "center",
      padding: "20px",
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

export default function App() {
  const [gs, setGs] = useState(load);
  const [savedFlash, setSavedFlash] = useState(false);
  const [screen, setScreen] = useState("game");
  const [rules, setRules] = useState(loadSettings);
  const [showSummary, setShowSummary] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(!hasOnboarded());

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
    upd(function(s) {
      const nilField = pnum === 1 ? "p1nil" : "p2nil";
      const bidField = pnum === 1 ? "p1bid" : "p2bid";
      const entry = s.entry.map(function(e, i) {
        if (i !== ti) return e;
        const newNil = cycleNil(e[nilField]);
        return Object.assign({}, e, { [nilField]: newNil, [bidField]: newNil > 0 ? "" : e[bidField] });
      });
      return Object.assign({}, s, { entry: entry });
    });
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
      const teams = s.teams.map(function(t, i) {
        if (i !== ti) return t;
        const p = [t.p[0], t.p[1]];
        p[pIdx] = val;
        return Object.assign({}, t, { p: p });
      });
      return Object.assign({}, s, { teams: teams });
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
        snap: s.teams.map(function(t) { return { name: t.name, p: [t.p[0], t.p[1]] }; }),
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

      if (winner !== null) {
        const gameRecord = buildGameRecord(
          Object.assign({}, s, { teams: newTeams, rounds: s.rounds.concat([round]) }),
          winner
        );
        saveGameToHistory(gameRecord);
        // Trigger summary card
        setTimeout(function() { setShowSummary(true); }, 800);
      }

      const lastResult = {
        round: roundNum,
        teams: newTeams.map(function(t, i) {
          return { name: t.name, pts: results[i].pts, lines: results[i].lines, score: t.score, wasSet: results[i].wasSet };
        }),
      };

      return Object.assign({}, s, {
        teams: newTeams,
        rounds: s.rounds.concat([round]),
        entry: [blank(), blank()],
        lastResult: lastResult,
        winner: winner,
      });
    });
  }

  function reset() {
    if (gs.rounds.length > 0) {
      const gameRecord = buildGameRecord(gs, gs.winner);
      saveGameToHistory(gameRecord);
    }
    try { localStorage.removeItem(STORAGE_KEY); } catch(_) {}
    setGs(newGame());
    setShowSummary(false);
  }

  // Combined tricks across BOTH teams must total exactly 13
  const bothTeamsTricksFilled = gs.entry.every(teamTricksFilled);
  const combinedTricks = gs.entry.reduce(function(sum, e) { return sum + teamTricks(e); }, 0);
  const anyTricksMismatch = bothTeamsTricksFilled && combinedTricks !== 13;
  const canScore = gs.entry.every(isReady) && !anyTricksMismatch;
  const anyBidOne = rules.minBid >= 2 && gs.entry.some(bidOneViolation);
  const anyBlindNil = gs.entry.some(function(e) { return e.p1nil === 2 || e.p2nil === 2; });
  const anySet = gs.entry.some(pendingSet);

  const scoreBtnBg = anyTricksMismatch ? RED : anyBidOne ? RED : anySet ? ORANGE : anyBlindNil ? BLUE : canScore ? GOLD : "rgba(255,255,255,0.12)";
  const scoreBtnLabel = anyTricksMismatch ? "Tricks must total exactly 13" : anyBidOne ? "Score Round (Override)" : anySet ? "Score Round (SET)" : anyBlindNil ? "Score Blind Nil Round" : canScore ? "Score Round" : "Fill in all fields…";

  if (screen === "history") return <HistoryScreen onClose={function() { setScreen("game"); }} />;
  if (screen === "settings") return <SettingsScreen onClose={function() { setScreen("game"); }} settings={rules} onSave={setRules} gameStarted={gs.rounds.length > 0} />;
  if (screen === "stats") return <StatsScreen onClose={function() { setScreen("game"); }} />;

  return (
    <div style={{ minHeight: "100vh", background: BG, backgroundImage: "radial-gradient(ellipse at 20% 50%, #0c1e3a 0%, transparent 50%), radial-gradient(ellipse at 80% 10%, #180a2a 0%, transparent 50%)", fontFamily: "Georgia, serif", color: "#e8dcc8", display: "flex", justifyContent: "center", alignItems: "flex-start" }}>
      <div style={{ width: "100%", maxWidth: "520px", display: "flex", flexDirection: "column", minHeight: "100vh" }}>

        {/* STICKY HEADER */}
        <div style={{ position: "sticky", top: 0, zIndex: 100, background: "rgba(9,13,27,0.97)", backdropFilter: "blur(12px)", borderBottom: "1px solid rgba(200,168,78,0.1)", padding: "10px 14px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
            <div style={{ fontSize: "9px", letterSpacing: "3px", color: "#1a2a3a" }}>SPADES</div>
            <div style={{ fontSize: "18px", letterSpacing: "4px", color: GOLD, fontVariant: "small-caps", textShadow: "0 0 20px rgba(200,168,78,0.4)" }}>Scorekeeper</div>
            <div style={{ fontSize: "9px", color: savedFlash ? GREEN : "#1a2a3a", transition: "color 0.3s" }}>{savedFlash ? "saved" : "auto"}</div>
          </div>

          <div style={{ display: "flex", gap: "6px", marginBottom: "10px" }}>
            <button onClick={function() { setScreen("history"); }} style={{ flex: 1, background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.12)", borderRadius: "7px", padding: "7px", fontSize: "10px", color: "#c0d0e0", cursor: "pointer", fontFamily: "Georgia, serif", letterSpacing: "1px", textTransform: "uppercase" }}>History</button>
            <button onClick={function() { setScreen("stats"); }} style={{ flex: 1, background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.12)", borderRadius: "7px", padding: "7px", fontSize: "10px", color: "#c0d0e0", cursor: "pointer", fontFamily: "Georgia, serif", letterSpacing: "1px", textTransform: "uppercase" }}>Player Stats</button>
            <button onClick={function() { setScreen("settings"); }} style={{ flex: 1, background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.12)", borderRadius: "7px", padding: "7px", fontSize: "10px", color: "#c0d0e0", cursor: "pointer", fontFamily: "Georgia, serif", letterSpacing: "1px", textTransform: "uppercase" }}>Rules ⚙</button>
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

              {gs.teams.map(function(team, ti) {
                return (
                  <TeamCard key={ti + team.name + team.p[0] + team.p[1]} team={team} ti={ti} entry={gs.entry}
                    onToggleNil={toggleNil} onField={setField}
                    onTeamName={function(v) { setTeamName(ti, v); }}
                    onPlayerName={setPlayerName} />
                );
              })}

              <button onClick={scoreRound} disabled={!canScore} style={{
                background: scoreBtnBg, color: canScore ? DIM : "#c8d8e8", border: "none", borderRadius: "10px",
                padding: "16px", fontSize: "15px", fontFamily: "Georgia, serif",
                fontWeight: "bold", letterSpacing: "2px", textTransform: "uppercase",
                cursor: canScore ? "pointer" : "not-allowed", width: "100%",
                opacity: canScore ? 1 : 0.85,
                boxShadow: canScore ? (anySet ? "0 0 20px rgba(232,148,58,0.5)" : anyBlindNil && !anyBidOne ? "0 0 20px rgba(0,191,255,0.4)" : "0 0 14px rgba(200,168,78,0.25)") : "none",
              }}>
                {scoreBtnLabel}
              </button>
            </>
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
                                <div style={{ color: p1n === 2 ? BLUE : p1n === 1 ? GOLD : "#b0c4d8", fontSize: "10px" }}>{nm.p[0]}: {p1n === 2 ? "Blind Nil" : p1n === 1 ? "Nil" : "bid " + re.p1bid} - {re.p1tricks} tricks{(p1n > 0 && parseInt(re.p1tricks) > 0) ? " ❌ NIL FAILED" : ""}{(p1n > 0 && parseInt(re.p1tricks) > 0) ? " ❌ NIL FAILED" : ""}</div>
                                <div style={{ color: p2n === 2 ? BLUE : p2n === 1 ? GOLD : "#b0c4d8", fontSize: "10px" }}>{nm.p[1]}: {p2n === 2 ? "Blind Nil" : p2n === 1 ? "Nil" : "bid " + re.p2bid} - {re.p2tricks} tricks</div>
                                {!(p1n > 0 && p2n > 0) && <div style={{ color: "#a0b8c8", fontSize: "10px" }}>Team bid: {tb}</div>}
                                {r.results[i].lines.map(function(l, li) {
                                  const isBad = l.indexOf("SET") !== -1 || l.indexOf("failed") !== -1;
                                  const isBlind = l.indexOf("Blind") !== -1;
                                  return <div key={li} style={{ color: isBad ? ORANGE : isBlind ? BLUE : GREEN, fontSize: "10px" }}>{l}</div>;
                                })}
                                <div style={{ color: r.results[i].pts >= 0 ? GREEN : RED, fontWeight: "bold", fontSize: "14px", marginTop: "5px" }}>{r.results[i].pts >= 0 ? "+" : ""}{r.results[i].pts} pts</div>
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
            <button onClick={reset} style={{ background: "transparent", color: RED, border: "1px solid rgba(224,92,92,0.2)", borderRadius: "8px", padding: "10px", fontSize: "10px", fontFamily: "Georgia, serif", letterSpacing: "2px", textTransform: "uppercase", cursor: "pointer", width: "100%" }}>
              Reset Game
            </button>
          )}

          <div style={{ textAlign: "center", fontSize: "9px", color: "#6a8a9a", letterSpacing: "2px", lineHeight: 2 }}>
            WIN AT {rules.winScore} - LOSE AT {rules.loseScore} - {rules.bagLimit} BAGS = {rules.bagPenalty}<br />NIL +/-100 - BLIND NIL +/-200 - MIN TEAM BID {rules.minBid}
          </div>
        </div>

      </div>

      {/* Game Summary Card Modal */}
      {showSummary && gs.winner !== null && (
        <GameSummaryCard gs={gs} rules={rules} onDismiss={function() { setShowSummary(false); }} />
      )}

      {/* Onboarding Carousel */}
      {showOnboarding && (
        <OnboardingOverlay onDismiss={function() { setShowOnboarding(false); }} />
      )}

      <style>{`
        @keyframes fadeIn { from { opacity: 0; transform: scale(0.95); } to { opacity: 1; transform: scale(1); } }
        @keyframes flashOrange { 0%,100% { opacity:1 } 50% { opacity:0.7 } }
        @keyframes flashBlue { 0%,100% { opacity:1 } 50% { opacity:0.7 } }
        @keyframes flashRed { 0%,100% { opacity:1 } 50% { opacity:0.7 } }
        input:focus { outline: none !important; border-color: #c8a84e !important; }
        input::placeholder { color: #a0b4c8; }
        input::-webkit-outer-spin-button, input::-webkit-inner-spin-button { -webkit-appearance: none; }
      `}</style>
    </div>
  );
}
