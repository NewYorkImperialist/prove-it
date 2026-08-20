"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CATS, GENRES, findCat, nonSprint, recommendedTime, shuffle, pickGenreRounds } from "@/lib/solo-catalog";
import { norm, nearMiss, findEntry } from "@/lib/solo-matching";
import { hasGeoBoard, geoMode as geoModeOf } from "@/lib/geo-cats";
import { fmtClock, todayEastern, prevDate } from "@/lib/format";
import { getJSON, postJSON } from "@/lib/browser/api";
import { ownerKeyIfCrowned, submitDailyResult } from "@/lib/browser/daily";
import * as store from "@/lib/browser/storage";
import { useStateRef } from "@/hooks/useStateRef";

const genGid = () => "s-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// Solo / daily runs: build a challenge, sprint through its rounds against the clock, then land
// on a shareable leaderboard. Everything here is judged client-side — there's no opponent to
// keep honest, and the server only stores the results.
export function useSolo({ onExitToMenu }) {
  const [screen, setScreen] = useState("create");

  /* ---------------- builder configuration ---------------- */
  const [byName, setByName] = useState("");
  const [mode, setMode] = useState("genre"); // "genre" (one genre, random category each round) | "custom"
  const [numRounds, setNumRounds] = useState(5);
  const [perRound, setPerRound, perRoundRef] = useStateRef(45);
  const [increment, setIncrement, incrementRef] = useStateRef(0);
  const [genre, setGenre] = useState(() => GENRES[0] || "");
  const [customRounds, setCustomRounds] = useState([]);
  const [quickCat, setQuickCat] = useState(() => (CATS[0] || {}).name || "");
  const [advOpen, setAdvOpen] = useState(false);
  const [createErr, setCreateErr] = useState("");
  const [busy, setBusy] = useState("");

  /* ---------------- the run ---------------- */
  const [challengeId, setChallengeId, challengeIdRef] = useStateRef(null);
  const [def, setDef, defRef] = useStateRef(null); // { id, rounds:[names], by, type, timer }
  const [isDaily, setIsDaily, isDailyRef] = useStateRef(false);
  const [dailyDate, setDailyDate] = useState("");
  // Where this run came from — keeps a friend's shared link out of the solo geography boards.
  const playOrigin = useRef("solo");
  // Set only by startGeoChallenge() — lets the done screen offer "play a different geography?"
  // instead of the generic "new challenge" link.
  const isGeoChallenge = useRef(false);
  const [roundCats, setRoundCats, roundCatsRef] = useStateRef([]);
  const [cur, setCur, curRef] = useStateRef(0);
  const scores = useRef([]);
  const wpms = useRef([]);
  const times = useRef([]);
  const runGid = useRef("");

  /* ---------------- the current round ---------------- */
  const named = useRef(new Set());
  const [count, setCount, countRef] = useStateRef(0);
  const [chips, setChips] = useState([]);
  const [timeLeft, setTimeLeft, timeLeftRef] = useStateRef(0);
  const curRoundSecs = useRef(0);
  const tid = useRef(null);
  const [cmsg, setCmsg] = useState("");
  const [shakeTick, setShakeTick] = useState(0);
  const [geoMode, setGeoMode, geoModeRef] = useStateRef(null); // "map" | "fill" | null
  const mapActive = useRef(false);
  const [showTotal, setShowTotal] = useState(false);
  const [remOn, setRemOn] = useState(false);
  const [fillProgress, setFillProgress] = useState({ filled: 0, total: 0 });
  const [geoRound, setGeoRound] = useState(null); // { cat, mode, key } — set when a round needs a board
  const geoRef = useRef(null); // the GeoMap module, imported on the first geography round
  const mapEl = useRef(null);
  const guesses = useRef([]);

  // Live typing speed, measured from the first keystroke of the round.
  const rChars = useRef(0);
  const rT0 = useRef(0);
  const [wpm, setWpm] = useState(0);
  const liveWpm = () => (rT0.current ? Math.round(rChars.current / 5 / Math.max(1 / 60, (Date.now() - rT0.current) / 60000)) : 0);

  /* ---------------- results ---------------- */
  const [missed, setMissed] = useState([]);
  const [missedOpen, setMissedOpen] = useState(true);
  const [between, setBetween] = useState(null);
  const [done, setDone] = useState(null);
  const [countdown, setCountdown] = useState(null); // "3" | "2" | "1" | "GO!"
  const [daily, setDaily] = useState(null); // today's puzzle summary, for the ready screen
  const [joinInfo, setJoinInfo] = useState(null);
  const [joinName, setJoinName] = useState("");
  const [joinErr, setJoinErr] = useState("");

  const visitorId = useMemo(() => (typeof window === "undefined" ? null : store.visitorId()), []);

  useEffect(() => {
    const n = store.getSoloName();
    setByName(n);
    setJoinName(n);
  }, []);

  useEffect(() => () => clearInterval(tid.current), []);

  /* ---------------- builder helpers ---------------- */
  // Custom mode pre-fills each round with a different sprintable category.
  const rebuildCustomRounds = useCallback((n) => {
    const sprintable = shuffle(CATS.filter((c) => !nonSprint(c)));
    setCustomRounds(Array.from({ length: n }, (_, i) => (sprintable[i] || CATS[0]).name));
  }, []);

  useEffect(() => {
    if (mode === "custom") rebuildCustomRounds(numRounds);
  }, [mode, numRounds, rebuildCustomRounds]);

  const clampPerRound = useCallback((s) => setPerRound(Math.max(5, Math.min(1800, parseInt(s, 10) || 45))), [setPerRound]);
  const clampIncrement = useCallback((s) => setIncrement(Math.max(0, Math.min(30, parseInt(s, 10) || 0))), [setIncrement]);

  /* ---------------- countdown ---------------- */
  const runCountdown = useCallback((doneCb) => {
    const seq = ["3", "2", "1", "GO!"];
    let i = 0;
    const step = () => {
      if (i >= seq.length) {
        setCountdown(null);
        doneCb();
        return;
      }
      setCountdown({ text: seq[i], key: i });
      i++;
      setTimeout(step, 800);
    };
    step();
  }, []);

  /* ---------------- a round ---------------- */
  const endRound = useCallback(() => {
    clearInterval(tid.current);
    const i = curRef.current;
    const cat = roundCatsRef.current[i];
    scores.current[i] = countRef.current;
    wpms.current[i] = liveWpm();
    // Fire-and-forget the exact guesses for the admin guess-log.
    if (guesses.current.length && challengeIdRef.current) {
      postJSON(`/challenge/${challengeIdRef.current}/guesses`, {
        gid: runGid.current,
        round: i,
        category: cat?.name,
        name: store.getSoloName(),
        guesses: guesses.current,
      });
    }
    // After a geography round, list what you missed so you can study it for next time.
    let items = [];
    if (cat && /^Geography/.test(cat.group)) {
      if (geoModeRef.current === "fill" && geoRef.current) items = geoRef.current.missedFill().map((m) => ({ q: m.q, a: m.a }));
      else items = cat.entries.filter((e) => !named.current.has(e.id)).map((e) => ({ q: e.display }));
    }
    setMissed(items);
    setMissedOpen(true);
    setBetween({
      round: i + 1,
      of: roundCatsRef.current.length,
      count: countRef.current,
      cat: cat?.name,
      wpm: wpms.current[i],
      running: scores.current.reduce((a, n) => a + (n || 0), 0),
      last: i + 1 >= roundCatsRef.current.length,
    });
    setScreen("between");
  }, [curRef, roundCatsRef, countRef, challengeIdRef, geoModeRef]);

  // Named everything → record how long it took (faster ranks higher) and end the round now.
  const finishRoundEarly = useCallback(() => {
    const i = curRef.current;
    if (times.current[i] == null) times.current[i] = Math.max(1, curRoundSecs.current - timeLeftRef.current);
    endRound();
  }, [curRef, timeLeftRef, endRound]);

  const startRound = useCallback(
    (i) => {
      setCur(i);
      named.current = new Set();
      guesses.current = [];
      rChars.current = 0;
      rT0.current = 0;
      setWpm(0);
      setCount(0);
      setChips([]);
      setCmsg("");
      setRemOn(false);
      if (i === 0) runGid.current = genGid(); // one id per run, threading every round's guesses
      const cat = roundCatsRef.current[i];
      setScreen("sprint");

      // Geography visuals: "map" categories light shapes up (chips stay), "fill" categories
      // show a countries/states grid you complete by typing capitals (the grid replaces chips).
      const gm = hasGeoBoard(cat.name) ? geoModeOf(cat.name) : null;
      mapActive.current = false;
      setGeoMode(gm);
      setShowTotal(!!gm); // "/ total" only for the enumerations, not misc geo like Natural Disasters
      setFillProgress({ filled: 0, total: 0 });

      // Per-round time: the recommended-per-round sentinel (timer 0) uses each category's length.
      curRoundSecs.current = defRef.current && Number(defRef.current.timer) === 0 ? recommendedTime(cat.name) : perRoundRef.current;
      setTimeLeft(curRoundSecs.current);
      clearInterval(tid.current);
      tid.current = setInterval(() => {
        const next = timeLeftRef.current - 1;
        setTimeLeft(next);
        setWpm(liveWpm());
        if (next <= 0) endRound();
      }, 1000);

      // The board itself is built by the effect below, once React has mounted its container.
      setGeoRound(gm ? { cat, mode: gm, key: i } : null);
      if (!gm && geoRef.current) geoRef.current.teardown();
    },
    [setCur, setCount, setGeoMode, setTimeLeft, timeLeftRef, roundCatsRef, defRef, perRoundRef, endRound],
  );

  // D3 needs a real, mounted node to draw into, so the geography board is set up after the
  // sprint screen commits — not inside startRound, where the container doesn't exist yet.
  useEffect(() => {
    if (!geoRound || !mapEl.current) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const mod = await import("@/lib/browser/geomap");
        if (cancelled || !mapEl.current) return;
        geoRef.current = mod.GeoMap;
        await mod.GeoMap.setup(geoRound.cat.name, geoRound.cat.entries, mapEl.current, named.current);
        if (cancelled) return;
        if (geoRound.mode === "fill") setFillProgress({ filled: mod.GeoMap.filled(), total: mod.GeoMap.total() });
        else mapActive.current = true;
      } catch {
        // Any failure (CDN down, no shapes for this list) falls back to the plain chip list.
        if (cancelled) return;
        setGeoMode(null);
        setShowTotal(false);
        mapActive.current = false;
        if (mapEl.current) mapEl.current.innerHTML = "";
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [geoRound, setGeoMode]);

  /* ---------------- answering ---------------- */
  const flash = useCallback((msg) => {
    setCmsg(msg);
    setShakeTick((n) => n + 1);
  }, []);

  // Adds this round's configured bonus time for a correct answer (0 = no-op).
  const bumpTimer = useCallback(() => {
    if (!incrementRef.current) return;
    setTimeLeft((t) => t + incrementRef.current);
  }, [incrementRef, setTimeLeft]);

  // Returns true when the text should be KEPT in the box (a near-miss → let them re-spell).
  const submit = useCallback(
    (q) => {
      rChars.current += q.length;
      if (!rT0.current) rT0.current = Date.now();
      setWpm(liveWpm());

      if (geoModeRef.current === "fill" && geoRef.current) {
        const r = geoRef.current.tryFill(q);
        if (r === "ok") {
          const filled = geoRef.current.filled(), total = geoRef.current.total();
          setCount(filled);
          setFillProgress({ filled, total });
          setCmsg("");
          guesses.current.push({ display: q, verdict: "ok", at: Date.now() });
          bumpTimer();
          if (filled >= total) finishRoundEarly();
          return false;
        }
        if (r === "dup") {
          flash("already filled in");
          return false;
        }
        guesses.current.push({ display: q, verdict: "miss", at: Date.now() });
        flash("✗ not a capital on the board");
        return false;
      }

      const cat = roundCatsRef.current[curRef.current];
      const nq = norm(q);
      const m = findEntry(cat, nq);
      if (m) {
        if (named.current.has(m.id)) {
          guesses.current.push({ display: m.display, verdict: "dup", at: Date.now() });
          flash("already got that one");
          return false;
        }
        named.current.add(m.id);
        setCount((c) => c + 1);
        setCmsg("");
        guesses.current.push({ display: m.display, verdict: "ok", at: Date.now() });
        bumpTimer();
        if (mapActive.current && geoRef.current) geoRef.current.light(m.id);
        setChips((c) => [m.display, ...c]);
        if (named.current.size >= cat.entries.length) finishRoundEarly(); // got them all
        return false;
      }

      const near = nearMiss(nq, cat);
      if (near && named.current.has(near.entry.id)) {
        flash("you've already named that one");
        return false;
      }
      if (near) {
        flash(near.kind === "specific" ? "almost — be more specific" : "almost — check your spelling");
        return true; // keep the text so they can re-spell it
      }
      guesses.current.push({ display: q, verdict: "miss", at: Date.now() });
      flash("✗ not on the list");
      return false;
    },
    [geoModeRef, roundCatsRef, curRef, setCount, flash, bumpTimer, finishRoundEarly],
  );

  /* ---------------- finishing ---------------- */
  const challengeUrl = useCallback(() => `${window.location.origin}/challenge.html?id=${challengeIdRef.current}`, [challengeIdRef]);

  const finish = useCallback(async () => {
    const total = scores.current.reduce((a, n) => a + (n || 0), 0);
    const list = wpms.current.filter((n) => n != null);
    const avgWpm = list.length ? Math.round(list.reduce((a, n) => a + n, 0) / list.length) : 0;
    const rounds = roundCatsRef.current.length;
    setScreen("done");

    if (isDailyRef.current) {
      // Retro-arcade order: show the score and streak first, then let them opt in by name.
      const streak = store.bumpDailyStreak(dailyDate, prevDate);
      store.saveDailyRun(total, { date: dailyDate, scores: scores.current, wpms: wpms.current, times: times.current, gid: runGid.current });
      setDone({
        daily: true,
        total,
        avgWpm,
        rounds,
        streak,
        verdict: "Daily complete!",
        sub: `You named ${total} today across ${rounds} rounds at ${avgWpm} wpm avg.${streak > 1 ? ` 🔥 ${streak}-day streak!` : ""}`,
        board: { kind: "challenge", id: challengeIdRef.current },
      });
      return;
    }

    await postJSON(`/challenge/${challengeIdRef.current}/result`, {
      name: store.getSoloName(),
      scores: scores.current,
      wpms: wpms.current,
      times: times.current,
      visitorId,
      ownerKey: ownerKeyIfCrowned(),
      gid: runGid.current,
      mode: playOrigin.current,
    });
    // A single-category run shows that category's all-time board — more meaningful than the
    // one-off link board.
    const single = rounds === 1 ? roundCatsRef.current[0] : null;
    setDone({
      daily: false,
      geoChallenge: isGeoChallenge.current,
      total,
      avgWpm,
      rounds,
      verdict: "Your run is in!",
      sub: single
        ? `You named ${total} ${single.name} at ${avgWpm} wpm avg.`
        : `You named ${total} across ${rounds} rounds at ${avgWpm} wpm avg. Send the link to friends · same questions, same leaderboard.`,
      board: single ? { kind: "category", name: single.name } : { kind: "challenge", id: challengeIdRef.current },
    });
  }, [roundCatsRef, isDailyRef, challengeIdRef, dailyDate, visitorId]);

  const nextRound = useCallback(() => {
    if (curRef.current + 1 >= roundCatsRef.current.length) finish();
    else startRound(curRef.current + 1);
  }, [curRef, roundCatsRef, finish, startRound]);

  /* ---------------- entering a run ---------------- */
  // The pre-game "ready" screen: copy the link to a friend, then start with a 3·2·1 countdown.
  const startPlaying = useCallback(
    (playerName) => {
      store.setSoloName(playerName);
      const cats = defRef.current.rounds.map(findCat).filter(Boolean);
      if (!cats.length) {
        setScreen("create");
        setCreateErr("This challenge's categories are unavailable.");
        return;
      }
      setRoundCats(cats);
      scores.current = [];
      times.current = [];
      wpms.current = [];
      setCur(0);
      setScreen("ready");
    },
    [defRef, setRoundCats, setCur],
  );

  const initCreate = useCallback(() => {
    setIsDaily(false);
    playOrigin.current = "solo";
    setByName(store.getSoloName());
    setCreateErr("");
    setScreen("create");
  }, [setIsDaily]);

  // Quick solo play: a real (DB-backed, shareable) run built from a fixed category list.
  // `geo` marks a run started from startGeoChallenge() below (drives the done screen's CTA).
  // `nameOverride` bypasses the byName state — used by the ?geo=1 deep link, which can fire
  // before a name typed elsewhere has actually propagated through React state.
  const startSolo = useCallback(
    async (rounds, seconds, geo = false, nameOverride) => {
      setCreateErr("");
      playOrigin.current = "solo";
      isGeoChallenge.current = geo;
      const by = (nameOverride ?? byName).trim().slice(0, 20);
      if (!by) return setCreateErr("Enter your name first.");
      store.setSoloName(by);
      if (nameOverride) setByName(by); // keep the field in sync if this came from a deep link
      if (seconds != null) clampPerRound(seconds);
      setBusy("starting");
      const res = await postJSON("/challenge", { type: "custom", genre: "", rounds, by, timer: seconds != null ? seconds : perRoundRef.current });
      setBusy("");
      if (!res.ok) return setCreateErr(res.error || "Could not start.");
      setChallengeId(res.id);
      setDef({ id: res.id, rounds, by, type: "custom", timer: seconds != null ? seconds : perRoundRef.current });
      window.history.replaceState({}, "", "?id=" + res.id);
      startPlaying(by);
    },
    [byName, clampPerRound, perRoundRef, setChallengeId, setDef, startPlaying],
  );

  // One geography category (the board/map ones — same pool the category leaderboards track) at
  // its recommended time, so the run is fair and lands on that category's board with no setup.
  // Random unless `catName` names a specific one (the done screen's "play a specific one" picker).
  const startGeoChallenge = useCallback((nameOverride, catName) => {
    setCreateErr("");
    const cat = catName || pickGenreRounds("Geography", 1)[0];
    if (!cat) return setCreateErr("No geography categories available right now.");
    startSolo([cat], recommendedTime(cat), true, nameOverride);
  }, [startSolo]);

  const createChallenge = useCallback(async () => {
    setCreateErr("");
    isGeoChallenge.current = false;
    const by = byName.trim().slice(0, 20);
    if (!by) return setCreateErr("Enter your name first.");
    store.setSoloName(by);
    const rounds = (mode === "genre" ? pickGenreRounds(genre, numRounds) : customRounds).filter(Boolean);
    if (!rounds.length) return setCreateErr("Pick at least one category.");
    const timer = perRoundRef.current;
    setBusy("creating");
    const res = await postJSON("/challenge", { type: mode, genre: mode === "genre" ? genre : "", rounds, by, timer });
    setBusy("");
    if (!res.ok) return setCreateErr(res.error || "Could not create challenge.");
    setChallengeId(res.id);
    setDef({ id: res.id, rounds, by, type: mode, timer });
    window.history.replaceState({}, "", "?id=" + res.id);
    startPlaying(by);
  }, [byName, mode, genre, numRounds, customRounds, perRoundRef, setChallengeId, setDef, startPlaying]);

  // Opened someone's ?id= link.
  const initJoin = useCallback(
    async (id) => {
      setIsDaily(false);
      playOrigin.current = "link"; // a friend's link is kept out of the solo geography boards
      setChallengeId(id);
      setScreen("join");
      setJoinInfo(null);
      setDef(null);
      const c = await getJSON(`/challenge/${id}`);
      if (!c.ok) {
        setCreateErr("That challenge link is invalid or expired · build a new one.");
        initCreate();
        return;
      }
      const d = { id: c.id, rounds: c.rounds || [], by: c.by, type: c.type, genre: c.genre, timer: c.timer == null ? 45 : c.timer }; // preserve 0
      setDef(d);
      setPerRound(d.timer || 45);
      setJoinInfo({
        by: d.by || "A friend",
        nRounds: d.rounds.length,
        genre: d.genre,
        timer: d.timer,
        rounds: d.rounds.map((n) => {
          const cat = findCat(n);
          return { name: n, nonSprint: !!cat && nonSprint(cat) };
        }),
      });
      setJoinName(store.getSoloName());
    },
    [setIsDaily, setChallengeId, setDef, setPerRound, initCreate],
  );

  const initDaily = useCallback(async () => {
    setIsDaily(true);
    playOrigin.current = "daily";
    setScreen("ready");
    setDone(null);
    setRoundCats([]);
    const d = await getJSON("/daily");
    if (!d.ok) {
      setIsDaily(false);
      setCreateErr(d.error || "Daily isn't available right now.");
      initCreate();
      return;
    }
    setChallengeId(d.id);
    setDailyDate(d.date);
    const dd = { id: d.id, rounds: d.rounds || [], by: "Daily", type: "daily", timer: d.timer || 30 };
    setDef(dd);
    setPerRound(dd.timer);
    setRoundCats(dd.rounds.map(findCat).filter(Boolean));
    scores.current = [];
    times.current = [];
    wpms.current = [];
    setCur(0);
    setDaily({ date: d.date, timer: d.timer, players: d.players });
  }, [setIsDaily, setChallengeId, setDef, setPerRound, setRoundCats, setCur, initCreate]);

  const giveUp = useCallback(() => endRound(), [endRound]);

  const toggleRemaining = useCallback(() => {
    setRemOn((on) => {
      const next = !on;
      if (geoRef.current) geoRef.current.toggleRemaining(next);
      return next;
    });
  }, []);

  // Back to the beginning (a fresh build screen), no page reload.
  const backToStart = useCallback(() => {
    clearInterval(tid.current);
    setChallengeId(null);
    setDef(null);
    window.history.replaceState({}, "", "/");
    initCreate();
  }, [setChallengeId, setDef, initCreate]);

  const leaveRun = useCallback(() => {
    clearInterval(tid.current);
    onExitToMenu();
  }, [onExitToMenu]);

  const submitDaily = useCallback(
    async (name) => {
      const run = { scores: scores.current, wpms: wpms.current, times: times.current, gid: runGid.current };
      return submitDailyResult({ name, run: scores.current.length ? run : null, challengeId: challengeIdRef.current, visitorId });
    },
    [challengeIdRef, visitorId],
  );

  // The number under the clock: raw count, "x / total" for the enumerations, or the fill grid's
  // own progress.
  const countLabel =
    geoMode === "fill"
      ? `${fillProgress.filled} / ${fillProgress.total}`
      : showTotal && roundCats[cur]
        ? `${count} / ${roundCats[cur].entries.length}`
        : String(count);

  return {
    screen, setScreen,
    // builder
    byName, setByName, mode, setMode, numRounds, setNumRounds, perRound, setPerRound: clampPerRound,
    increment, setIncrement: clampIncrement,
    genre, setGenre, customRounds, setCustomRounds, quickCat, setQuickCat, advOpen, setAdvOpen,
    createErr, busy,
    // run
    challengeId, def, isDaily, daily, dailyDate, roundCats, cur, visitorId,
    // round
    count, countLabel, chips, timeLeft, clock: fmtClock(Math.max(0, timeLeft)), wpm, cmsg, shakeTick,
    geoMode, remOn, mapEl, missed, missedOpen, setMissedOpen, between, done, countdown,
    joinInfo, joinName, setJoinName, joinErr, setJoinErr,
    // actions
    initCreate, initJoin, initDaily, createChallenge, startSolo, startGeoChallenge, startPlaying, runCountdown,
    startRound, submit, giveUp, nextRound, toggleRemaining, backToStart, leaveRun, challengeUrl, submitDaily,
    todayEastern,
  };
}
