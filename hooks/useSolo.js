"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CATS, GENRES, findCat, nonSprint, recommendedTime, shuffle, pickGenreRounds, geoChallengeCats } from "@/lib/solo-catalog";
import { norm, nearMiss, findEntry } from "@/lib/solo-matching";
import { hasGeoBoard, geoMode as geoModeOf } from "@/lib/geo-cats";
import { fmtClock, todayEastern, prevDate } from "@/lib/format";
import { getJSON, postJSON, isNameBlocked } from "@/lib/browser/api";
import { ownerKeyIfCrowned, submitDailyResult } from "@/lib/browser/daily";
import * as store from "@/lib/browser/storage";
import { useStateRef } from "@/hooks/useStateRef";

const genGid = () => "s-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// Which challenge THIS tab started, remembered for the length of the tab. A run pushes its
// ?id= into the address bar (that's the shareable link), so a reload used to come back through
// the deep-link path and greet the player with their own run as a stranger's — "Tester
// challenged you to name as many as you can…". sessionStorage is the right scope: per tab,
// gone when the tab is, and it can't leak into the link you send a friend.
const OWN_RUN_KEY = "solo_own_run";
const OWN_RUN_DONE_KEY = "solo_own_run_done";
const markOwnRun = (id, played = false) => {
  try {
    window.sessionStorage.setItem(played ? OWN_RUN_DONE_KEY : OWN_RUN_KEY, id);
  } catch {
    /* private mode: we just lose the "this was yours" framing */
  }
};
// "" (not ours) | "playing" (reloaded mid-run — the run is gone) | "played" (already finished it).
const ownRunState = (id) => {
  if (!id) return "";
  try {
    if (window.sessionStorage.getItem(OWN_RUN_DONE_KEY) === id) return "played";
    return window.sessionStorage.getItem(OWN_RUN_KEY) === id ? "playing" : "";
  } catch {
    return "";
  }
};

// One wording for a rejected name, shared by the builder and the join screen (the daily's
// opt-in box in DoneSection says the same thing).
const BLOCKED_NAME = "That name isn't allowed — try a different one.";

const MAX_WPM = 300; // faster than anyone sustains — past this it was pasted, not typed
const PASTE_CHARS = 12; // one input event adding more than this at once wasn't typing either

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
  // Set only by startGeoChallenge() — lets the done screen offer its "play a specific one next"
  // category picker instead of the generic "new challenge" link.
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
  const [flagSel, setFlagSel, flagSelRef] = useStateRef(0); // index of the highlighted flag, in a Flags quiz round
  const mapActive = useRef(false);
  const [showTotal, setShowTotal] = useState(false);
  // Set when the geography board can't be drawn (the atlases come off a CDN at runtime), so the
  // round can say why the map, the running total and "Show what's left" all just went away.
  // { text, fatal } — fatal means the board WAS the question (a Borders or Flags quiz), so the
  // round can't be scored without it. Null when the board is fine.
  const [geoErr, setGeoErr] = useState(null);
  // A Flags quiz draws <img> tags straight from flagcdn, nowhere near the geomap effect below, so
  // it reports its own failure: with no images there is no question on screen at all, and every
  // guess comes back "that's on the list, but not this one" against an invisible target.
  const reportFlagsUnavailable = useCallback(() => {
    setGeoErr({ text: "The flag images didn't load, so there's nothing to identify. Skip to the next round.", fatal: true });
  }, []);
  const [remOn, setRemOn] = useState(false);
  const [fillProgress, setFillProgress] = useState({ filled: 0, total: 0 });
  const [geoRound, setGeoRound] = useState(null); // { cat, mode, key } — set when a round needs a board
  const geoRef = useRef(null); // the GeoMap module, imported on the first geography round
  const mapEl = useRef(null);
  const guesses = useRef([]);

  // Live typing speed, measured from the first keystroke of the round. It used to start at the
  // first submitted ANSWER, so the elapsed time was zero for that answer and the divide-by-zero
  // floor below reported `chars × 12` — a one-answer round claimed 60-200 wpm however slowly it
  // was typed, and a long paste read in the thousands.
  const rChars = useRef(0);
  const rT0 = useRef(0);
  const rLastLen = useRef(0);
  const [wpm, setWpm] = useState(0);
  const liveWpm = () => {
    if (!rT0.current) return 0;
    const mins = Math.max(1 / 60, (Date.now() - rT0.current) / 60000);
    return Math.min(MAX_WPM, Math.round(rChars.current / 5 / mins));
  };
  // Called on every keystroke in the answer box. Counts characters actually typed, so a
  // near-miss that gets re-spelled and re-submitted isn't billed twice. The box is cleared
  // programmatically between answers (no change event), which costs us the first character of
  // each answer — deliberately conservative: it can only under-report, never invent speed.
  const noteTyping = useCallback((len) => {
    if (!rT0.current) rT0.current = Date.now();
    const delta = len - rLastLen.current;
    rLastLen.current = len;
    if (delta > 0 && delta <= PASTE_CHARS) rChars.current += delta;
    setWpm(liveWpm());
  }, []);

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
  const [saveErr, setSaveErr] = useState("");
  const [resumeInfo, setResumeInfo] = useState(null); // a snapshot found on boot, offered on the create screen

  const visitorId = useMemo(() => (typeof window === "undefined" ? null : store.visitorId()), []);

  useEffect(() => {
    const n = store.getSoloName();
    setByName(n);
    setJoinName(n);
  }, []);

  // A finished run's result POST can fail with nothing telling the player — they still see
  // "Your run is in!" client-side while the server never heard about it (this is exactly what
  // happened to a player's perfect World Capitals run during a deploy: the request landed mid
  // server-restart and silently died). Retries with backoff, and keeps the payload in
  // localStorage until the server actually confirms it, so it survives a reload too.
  const trySaveResult = useCallback(async (challengeId, payload) => {
    store.savePendingResult(challengeId, payload);
    setSaveErr("");
    const delays = [0, 1500, 4000, 9000]; // 4 attempts, ~15s of retrying before giving up
    for (const d of delays) {
      if (d) await new Promise((r) => setTimeout(r, d));
      const res = await postJSON(`/challenge/${challengeId}/result`, payload);
      if (res.ok) {
        store.clearPendingResult();
        return true;
      }
    }
    setSaveErr("Couldn't save your run to the leaderboard — check your connection. It's kept safe on this device; tap to try again.");
    return false;
  }, []);

  // The done screen's "tap to retry" button, and the same thing tried once, quietly, whenever
  // the app boots — so a run that failed to save last visit still gets another shot even if the
  // player never comes back to that screen.
  const retryPendingResult = useCallback(() => {
    const pending = store.getPendingResult();
    if (pending) trySaveResult(pending.challengeId, pending.payload);
  }, [trySaveResult]);

  useEffect(() => {
    retryPendingResult();
  }, [retryPendingResult]);

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
    // After a geography round, list what you missed so you can study it for next time. Flags
    // and Borders quizzes are folded into the Geography group, so this already covers them.
    let items = [];
    if (cat && /^Geography/.test(cat.group)) {
      if (geoModeRef.current === "fill" && geoRef.current) items = geoRef.current.missedFill().map((m) => ({ q: m.q, a: m.a }));
      else items = cat.entries.filter((e) => !named.current.has(e.id)).map((e) => ({ q: e.display }));
      // Feeds the Geography screen's "N of 27 boards cleared". Recorded per ROUND, not per run, so
      // a geography board inside a mixed custom run counts the same as one played on its own.
      const total = geoModeRef.current === "fill" && geoRef.current ? geoRef.current.total() : cat.entries.length;
      store.recordGeoBoard(cat.name, countRef.current, total);
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

  // A round's whole recoverable state, in localStorage: which run, which round, what's already
  // named, and a real deadline (not a countdown) so a reload — or the server restarting mid-run
  // for a deploy — deducts however long you were actually away instead of resetting the clock.
  const snapshotRun = useCallback(
    (secsOverride) => {
      if (!challengeIdRef.current || !defRef.current) return;
      const secs = secsOverride != null ? secsOverride : timeLeftRef.current;
      const cat = roundCatsRef.current[curRef.current];
      store.saveResumeRun({
        challengeId: challengeIdRef.current,
        def: defRef.current,
        cur: curRef.current,
        scores: scores.current,
        times: times.current,
        wpms: wpms.current,
        namedIds: [...named.current],
        deadline: Date.now() + secs * 1000,
        flagSel: flagSelRef.current,
        // A picture quiz's grid order is shuffled fresh each play — remember it so a resume
        // shows the exact same arrangement flagSel was pointing into, not a new shuffle.
        entryOrder: cat && (cat.isFlagQuiz || cat.isBorderQuiz) ? cat.entries.map((e) => e.id) : undefined,
        runGid: runGid.current,
        isGeoChallenge: isGeoChallenge.current,
        playOrigin: playOrigin.current,
        isDaily: isDailyRef.current,
        dailyDate,
        savedAt: Date.now(),
      });
    },
    [challengeIdRef, defRef, curRef, timeLeftRef, flagSelRef, roundCatsRef, isDailyRef, dailyDate],
  );

  // `resumeData` (optional): `{ namedIds, secsLeft, entryOrder }` from a saved snapshot — picks
  // the round back up instead of starting it fresh (see resumeRun()).
  const startRound = useCallback(
    (i, resumeData) => {
      setCur(i);
      let cat = roundCatsRef.current[i];
      // Picture quizzes (Flags, Borders) get a fresh shuffle every time they're played, so the
      // grid isn't the same predictable alphabetical order round after round. A resume restores
      // the exact order it was interrupted in instead — flagSel is an index into this array, so
      // reshuffling on resume would highlight a different country than the one you left on.
      if (cat.isFlagQuiz || cat.isBorderQuiz) {
        let entries;
        if (resumeData && resumeData.entryOrder) {
          const byId = new Map(cat.entries.map((e) => [e.id, e]));
          entries = resumeData.entryOrder.map((id) => byId.get(id)).filter(Boolean);
        } else {
          entries = shuffle(cat.entries);
        }
        cat = { ...cat, entries };
        setRoundCats((arr) => arr.map((c, idx) => (idx === i ? cat : c)));
      }
      named.current = new Set(resumeData ? resumeData.namedIds : []);
      guesses.current = [];
      rChars.current = 0;
      rT0.current = 0;
      rLastLen.current = 0;
      setWpm(0);
      setCount(named.current.size);
      setCmsg("");
      setRemOn(false);
      setFlagSel(resumeData ? resumeData.flagSel || 0 : 0);
      if (i === 0 && !resumeData) runGid.current = genGid(); // one id per run, threading every round's guesses
      setChips(resumeData ? cat.entries.filter((e) => named.current.has(e.id)).map((e) => e.display) : []);
      setScreen("sprint");

      // Geography visuals: "map" categories light shapes up (chips stay), "fill" categories
      // show a countries/states grid you complete by typing capitals (the grid replaces chips).
      const gm = hasGeoBoard(cat.name) ? geoModeOf(cat.name) : null;
      mapActive.current = false;
      setGeoMode(gm);
      setShowTotal(!!gm || !!cat.isFlagQuiz || !!cat.isBorderQuiz); // "/ total" for the enumerations and picture quizzes
      setFillProgress({ filled: 0, total: 0 });

      // Per-round time: the recommended-per-round sentinel (timer 0) uses each category's length.
      // curRoundSecs is always the FULL budget (never shortened by a resume) — finishRoundEarly's
      // elapsed-time math (curRoundSecs - timeLeft) only comes out right if it stays the total.
      curRoundSecs.current = defRef.current && Number(defRef.current.timer) === 0 ? recommendedTime(cat.name) : perRoundRef.current;
      setTimeLeft(resumeData ? resumeData.secsLeft : curRoundSecs.current);
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

      if (!resumeData) snapshotRun(curRoundSecs.current);
    },
    [setCur, setCount, setGeoMode, setFlagSel, setTimeLeft, timeLeftRef, roundCatsRef, setRoundCats, defRef, perRoundRef, endRound, snapshotRun],
  );

  // D3 needs a real, mounted node to draw into, so the geography board is set up after the
  // sprint screen commits — not inside startRound, where the container doesn't exist yet.
  useEffect(() => {
    if (!geoRound || !mapEl.current) return undefined;
    let cancelled = false;
    setGeoErr(null); // a new round gets a clean slate — last round's CDN failure isn't this one's
    (async () => {
      try {
        const mod = await import("@/lib/browser/geomap");
        if (cancelled || !mapEl.current) return;
        geoRef.current = mod.GeoMap;
        await mod.GeoMap.setup(geoRound.cat.name, geoRound.cat.entries, mapEl.current, named.current);
        if (cancelled) return;
        if (geoRound.mode === "fill") setFillProgress({ filled: mod.GeoMap.filled(), total: mod.GeoMap.total() });
        else mapActive.current = true;
        // Borders quiz: the map just (re)loaded, so it has no idea which shape is the current
        // target yet — give it the one flagSel was already pointing to (0 on a fresh round, or
        // wherever a resume left off).
        if (geoRound.cat.isBorderQuiz) mod.GeoMap.highlight(geoRound.cat.entries[flagSelRef.current]?.id ?? null);
      } catch {
        // Any failure (CDN down, no shapes for this list) drops the board — but says so, because
        // silently losing the map, the total and "Show what's left" mid-round looked like the
        // round itself had broken.
        //
        // What it says depends on whether the board IS the question. In a plain map round the
        // shapes are an aid: every country is still a valid answer, so "keep typing" is true. In
        // a Borders quiz only the ONE highlighted country counts (see submit()), and the highlight
        // lives on the map that just failed — so there is nothing left to answer, and telling
        // someone their answers still count is a lie that leaves them typing into a round they
        // cannot score in.
        if (cancelled) return;
        const needsBoard = !!geoRound.cat.isBorderQuiz;
        setGeoMode(null);
        setShowTotal(false);
        setGeoErr(needsBoard
          ? { text: "This quiz needs its map, and the map didn't load — there's nothing to name without it. Skip to the next round.", fatal: true }
          : { text: "Couldn't load the map for this round — your answers still count, so keep typing.", fatal: false });
        mapActive.current = false;
        if (mapEl.current) mapEl.current.innerHTML = "";
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [geoRound, setGeoMode]);

  // Borders quiz: move the map's highlight whenever flagSel moves (a correct answer advancing
  // it, or an arrow key). The setup effect above only handles the very first one — this handles
  // every one after, once the map's actually ready.
  useEffect(() => {
    const cat = roundCatsRef.current[curRef.current];
    if (!cat || !cat.isBorderQuiz || !geoRef.current) return;
    geoRef.current.highlight(cat.entries[flagSel]?.id ?? null);
  }, [flagSel, roundCatsRef, curRef]);

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

  // Picture quizzes (Flags, Borders): unlike every other round, an answer only counts
  // against the ONE highlighted tile — naming a real country from the list that isn't this one
  // is still a miss, just a more informative one. Correct advances the highlight to the next
  // unsolved tile.
  const nextUnsolvedTile = (cat, fromIdx) => {
    for (let step = 1; step <= cat.entries.length; step++) {
      const i = (fromIdx + step) % cat.entries.length;
      if (!named.current.has(cat.entries[i].id)) return i;
    }
    return fromIdx; // everything's solved — finishRoundEarly() is about to fire anyway
  };

  // Moves the highlighted tile left/right (also used for up/down — the grid reflows by screen
  // width, so there's no reliable row math to do arrow-key-accurate 2D navigation with). Shared
  // by both picture quizzes (Flags, Borders) — same grid, same highlight, different image.
  const moveFlagSel = useCallback(
    (delta) => {
      const cat = roundCatsRef.current[curRef.current];
      if (!cat || (!cat.isFlagQuiz && !cat.isBorderQuiz)) return;
      setFlagSel((i) => Math.max(0, Math.min(cat.entries.length - 1, i + delta)));
    },
    [roundCatsRef, curRef, setFlagSel],
  );

  // Returns true when the text should be KEPT in the box (a near-miss → let them re-spell).
  const submit = useCallback(
    (q) => {
      setWpm(liveWpm()); // the characters themselves were counted as they were typed (noteTyping)

      const cat0 = roundCatsRef.current[curRef.current];
      if (cat0.isFlagQuiz || cat0.isBorderQuiz) {
        const entry = cat0.entries[flagSelRef.current];
        const nq = norm(q);
        if (entry.aliases.includes(nq)) {
          if (named.current.has(entry.id)) {
            flash("already got that one");
            return false;
          }
          named.current.add(entry.id);
          setCount((c) => c + 1);
          setCmsg("");
          guesses.current.push({ display: entry.display, verdict: "ok", at: Date.now() });
          bumpTimer();
          if (cat0.isBorderQuiz && geoRef.current) geoRef.current.light(entry.id); // fills the shape in amber on the map
          setFlagSel(nextUnsolvedTile(cat0, flagSelRef.current));
          snapshotRun();
          if (named.current.size >= cat0.entries.length) finishRoundEarly(); // got them all
          return false;
        }
        const other = findEntry(cat0, nq);
        if (other) {
          flash(named.current.has(other.id) ? "that one's already done, and not this one anyway" : "that's on the list, but not this one");
          return false;
        }
        const near = nearMiss(nq, { entries: [entry] });
        if (near) {
          flash("almost — check your spelling");
          return true; // keep the text so they can re-spell it
        }
        guesses.current.push({ display: q, verdict: "miss", at: Date.now() });
        flash("✗ not this one");
        return false;
      }

      if (geoModeRef.current === "fill" && geoRef.current) {
        const r = geoRef.current.tryFill(q);
        if (r === "ok") {
          const filled = geoRef.current.filled(), total = geoRef.current.total();
          setCount(filled);
          setFillProgress({ filled, total });
          setCmsg("");
          guesses.current.push({ display: q, verdict: "ok", at: Date.now() });
          bumpTimer();
          snapshotRun();
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
        snapshotRun();
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
    [geoModeRef, roundCatsRef, curRef, flagSelRef, setFlagSel, setCount, flash, bumpTimer, finishRoundEarly, snapshotRun],
  );

  /* ---------------- finishing ---------------- */
  const challengeUrl = useCallback(() => `${window.location.origin}/challenge.html?id=${challengeIdRef.current}`, [challengeIdRef]);

  const finish = useCallback(() => {
    const total = scores.current.reduce((a, n) => a + (n || 0), 0);
    const list = wpms.current.filter((n) => n != null);
    const avgWpm = list.length ? Math.round(list.reduce((a, n) => a + n, 0) / list.length) : 0;
    const rounds = roundCatsRef.current.length;
    setScreen("done");
    store.clearResumeRun(); // the run is over — nothing left to resume

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

    // Fire-and-retry, not fire-and-forget: setDone() below shouldn't wait on the network, but the
    // save itself needs to survive more than one silent failed attempt (see trySaveResult).
    trySaveResult(challengeIdRef.current, {
      name: store.getSoloName(),
      scores: scores.current,
      wpms: wpms.current,
      times: times.current,
      visitorId,
      ownerKey: ownerKeyIfCrowned(),
      gid: runGid.current,
      mode: playOrigin.current,
    });
    markOwnRun(challengeIdRef.current, true); // a reload from here must not present the run as someone else's
    // A single-category run shows that category's all-time board — more meaningful than the
    // one-off link board.
    const single = rounds === 1 ? roundCatsRef.current[0] : null;
    // "You named 1 US States" — a bare count in front of a plural category name only reads
    // when there's more than one.
    const named = single
      ? total === 1
        ? `You named 1 answer in ${single.name}`
        : `You named ${total} ${single.name}`
      : `You named ${total} across ${rounds} ${rounds === 1 ? "round" : "rounds"}`;
    const savedSub = single
      ? `${named} at ${avgWpm} wpm avg.`
      : `${named} at ${avgWpm} wpm avg. Send the link to friends · same rounds, same leaderboard.`;
    setDone({
      daily: false,
      geoChallenge: isGeoChallenge.current,
      total,
      avgWpm,
      rounds,
      // A failed write isn't reported here: trySaveResult keeps retrying and surfaces
      // solo.saveErr on the result screen, which replaces this headline (DoneSection) rather
      // than sitting under a contradicting "Your run is in!".
      verdict: "Your run is in!",
      sub: savedSub,
      board: single ? { kind: "category", name: single.name } : { kind: "challenge", id: challengeIdRef.current },
    });
  }, [roundCatsRef, isDailyRef, challengeIdRef, dailyDate, visitorId, trySaveResult]);

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

  // A run interrupted by a reload, a closed tab, or the server restarting mid-round leaves a
  // snapshot behind (see snapshotRun). Offer it once on boot rather than jumping straight back
  // in — a stale one (long since expired, or from a much older visit) is just discarded.
  useEffect(() => {
    const snap = store.getResumeRun();
    if (!snap) return;
    const graceMs = 10 * 60 * 1000; // still offered up to 10 minutes past its own deadline
    const tooOld = Date.now() - snap.savedAt > 6 * 60 * 60 * 1000; // or if it's just from ages ago
    if (Date.now() > snap.deadline + graceMs || tooOld) {
      store.clearResumeRun();
      return;
    }
    setResumeInfo(snap);
  }, []);

  const dismissResume = useCallback(() => {
    store.clearResumeRun();
    setResumeInfo(null);
  }, []);

  const resumeRun = useCallback(() => {
    const snap = resumeInfo;
    if (!snap) return;
    setResumeInfo(null);
    playOrigin.current = snap.playOrigin || "solo";
    isGeoChallenge.current = !!snap.isGeoChallenge;
    runGid.current = snap.runGid || genGid();
    setIsDaily(!!snap.isDaily);
    if (snap.isDaily) setDailyDate(snap.dailyDate || "");
    setChallengeId(snap.challengeId);
    setDef(snap.def);
    const cats = (snap.def.rounds || []).map(findCat).filter(Boolean);
    if (!cats.length || !cats[snap.cur]) {
      store.clearResumeRun();
      // setCreateErr only renders on the builder, and resuming can now be offered from the join
      // screen too — so go where the explanation is, or it's a dead button.
      setScreen("create");
      setCreateErr("That run's categories aren't available anymore.");
      return;
    }
    setRoundCats(cats);
    scores.current = snap.scores || [];
    times.current = snap.times || [];
    wpms.current = snap.wpms || [];
    const secsLeft = Math.max(0, Math.round((snap.deadline - Date.now()) / 1000));
    startRound(snap.cur, { namedIds: snap.namedIds || [], flagSel: snap.flagSel, entryOrder: snap.entryOrder, secsLeft });
  }, [resumeInfo, setChallengeId, setDef, setRoundCats, setIsDaily, startRound]);

  // `msg` is shown on the builder. The daily / dead-link failures used to set the error and THEN
  // come through here, which wiped it — you were dropped back on "Play solo" with no idea why,
  // even though the server had answered with a real reason.
  const initCreate = useCallback((msg) => {
    setIsDaily(false);
    playOrigin.current = "solo";
    setByName(store.getSoloName());
    setCreateErr(typeof msg === "string" ? msg : "");
    setScreen("create");
  }, [setIsDaily]);

  // Quick solo play: a real (DB-backed, shareable) run built from a fixed category list.
  // `geo` marks a run started from startGeoChallenge() below (drives the done screen's CTA).
  const startSolo = useCallback(
    async (rounds, seconds, geo = false) => {
      setCreateErr("");
      playOrigin.current = "solo";
      isGeoChallenge.current = geo;
      const by = byName.trim().slice(0, 20);
      if (!by) { setCreateErr("Enter your name first."); return false; }
      if (seconds != null) clampPerRound(seconds);
      setBusy("starting");
      // Pre-check the name here (routes/challenge.js's /name-check) instead of letting the
      // server's cleanName() swap it for "Anon" and leaving the player to wonder why the
      // leaderboard says "Anon (you)".
      if (await isNameBlocked(by)) {
        setBusy("");
        setCreateErr(BLOCKED_NAME);
        return false;
      }
      store.setSoloName(by);
      const res = await postJSON("/challenge", { type: "custom", genre: "", rounds, by, timer: seconds != null ? seconds : perRoundRef.current });
      setBusy("");
      // Returns a boolean because the caller may need to navigate ONLY on success: the Geography
      // screen used to route to the solo view first and start the run afterwards, so every failure
      // here (no persistence, lockdown, a blocked name) surfaced createErr on a builder the player
      // never asked for — and a slow round-trip flashed that builder on the way through.
      if (!res.ok) { setCreateErr(res.error || "Could not start."); return false; }
      setChallengeId(res.id);
      setDef({ id: res.id, rounds, by, type: "custom", timer: seconds != null ? seconds : perRoundRef.current });
      markOwnRun(res.id);
      window.history.replaceState({}, "", "?id=" + res.id);
      startPlaying(by);
      return true;
    },
    [byName, clampPerRound, perRoundRef, setChallengeId, setDef, startPlaying],
  );

  // One geography category (the board/map ones — same pool the category leaderboards track) at
  // its recommended time, so the run is fair and lands on that category's board with no setup.
  // Random unless `catName` names a specific one (the Create screen's picker, or the done
  // screen's "play a specific one" follow-up).
  const startGeoChallenge = useCallback((catName) => {
    setCreateErr("");
    // Draw from the board-having pool, not the Geography group: pickGenreRounds("Geography") also
    // holds the plain typing lists (Major Rivers, Deserts, Seas and Oceans), so a random
    // "Geography Challenge" could land on a round with nothing to draw at all.
    const cat = catName || shuffle(geoChallengeCats())[0];
    if (!cat) { setCreateErr("No geography boards available right now."); return false; }
    return startSolo([cat], recommendedTime(cat), true);
  }, [startSolo]);

  const createChallenge = useCallback(async () => {
    setCreateErr("");
    isGeoChallenge.current = false;
    const by = byName.trim().slice(0, 20);
    if (!by) return setCreateErr("Enter your name first.");
    const rounds = (mode === "genre" ? pickGenreRounds(genre, numRounds) : customRounds).filter(Boolean);
    if (!rounds.length) return setCreateErr("Pick at least one category.");
    const timer = perRoundRef.current;
    setBusy("creating");
    if (await isNameBlocked(by)) { // same pre-check as quick play — never silently become "Anon"
      setBusy("");
      return setCreateErr(BLOCKED_NAME);
    }
    store.setSoloName(by);
    const res = await postJSON("/challenge", { type: mode, genre: mode === "genre" ? genre : "", rounds, by, timer });
    setBusy("");
    if (!res.ok) return setCreateErr(res.error || "Could not create challenge.");
    setChallengeId(res.id);
    setDef({ id: res.id, rounds, by, type: mode, timer });
    markOwnRun(res.id);
    window.history.replaceState({}, "", "?id=" + res.id);
    startPlaying(by);
  }, [byName, mode, genre, numRounds, customRounds, perRoundRef, setChallengeId, setDef, startPlaying]);

  // Opened a ?id= link — someone else's, or (after a reload mid-run) our own.
  const initJoin = useCallback(
    async (id) => {
      setIsDaily(false);
      const mine = ownRunState(id);
      playOrigin.current = mine ? "solo" : "link"; // a friend's link is kept out of the solo geography boards
      setChallengeId(id);
      setScreen("join");
      setJoinInfo(null);
      setDef(null);
      const c = await getJSON(`/challenge/${id}`);
      if (!c.ok) {
        // The message has to be set AFTER initCreate, which clears it — otherwise a dead or
        // expired link just dumped you on "Play solo" with nothing said.
        initCreate("That challenge link is invalid or expired · build a new one.");
        return;
      }
      const d = { id: c.id, rounds: c.rounds || [], by: c.by, type: c.type, genre: c.genre, timer: c.timer == null ? 45 : c.timer }; // preserve 0
      setDef(d);
      setPerRound(d.timer || 45);
      setJoinInfo({
        by: d.by || "A friend",
        mine, // "playing" / "played": your own run, reloaded — not a stranger's challenge
        nRounds: d.rounds.length,
        genre: d.genre,
        timer: d.timer,
        rounds: d.rounds.map((n) => {
          const cat = findCat(n);
          return { name: n, nonSprint: !!cat && nonSprint(cat) };
        }),
      });
      setJoinName(store.getSoloName());
      setJoinErr("");
    },
    [setIsDaily, setChallengeId, setDef, setPerRound, initCreate],
  );

  // "Start the challenge" on a join card: the name goes on a leaderboard, so pre-check it here
  // too rather than letting the server quietly file the run under "Anon".
  const startJoin = useCallback(
    async (rawName) => {
      const n = String(rawName || "").trim().slice(0, 20);
      if (!n) return setJoinErr("Enter your name first.");
      setJoinErr("");
      setBusy("joining");
      const blocked = await isNameBlocked(n);
      setBusy("");
      if (blocked) return setJoinErr(BLOCKED_NAME);
      startPlaying(n);
    },
    [startPlaying],
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
      // Same ordering trap as initJoin: initCreate() clears createErr, so the server's real
      // reason ("Daily needs persistence (not configured).") has to travel through it.
      initCreate(d.error || "Daily isn't available right now.");
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
    store.clearResumeRun(); // an explicit exit means this run's abandoned, not interrupted
    setChallengeId(null);
    setDef(null);
    window.history.replaceState({}, "", "/");
    initCreate();
  }, [setChallengeId, setDef, initCreate]);

  const leaveRun = useCallback(() => {
    clearInterval(tid.current);
    store.clearResumeRun();
    onExitToMenu();
  }, [onExitToMenu]);

  const submitDaily = useCallback(
    async (name) => {
      const run = { scores: scores.current, wpms: wpms.current, times: times.current, gid: runGid.current };
      return submitDailyResult({ name, run: scores.current.length ? run : null, challengeId: challengeIdRef.current, visitorId });
    },
    [challengeIdRef, visitorId],
  );

  // Every non-daily run already saved itself (and a name) the moment it finished — this is just
  // for fixing that name afterward. Unlike submitDaily, there's no run to (re)submit: the score
  // is already on the board under this visitorId, so a rename just needs to update it there, the
  // same /challenge/rename call the daily "add me" flow uses to fix every board in one go.
  const renameRun = useCallback(
    async (name) => {
      const n = String(name || "").trim().slice(0, 20);
      if (!n) return { ok: false };
      if (await isNameBlocked(n)) return { ok: false, blocked: true };
      store.setSoloName(n);
      // Read the answer rather than discarding it: this returned { ok: true } unconditionally, so
      // "Update" reported success even when the rename never landed, and the caller's own failure
      // branch could never fire for a non-daily run.
      // gid comes along because the server won't rename on a bare visitorId any more — that value is
      // published on every leaderboard, so it identifies the rows without proving they're yours.
      // The finished run already saved itself under this gid, so it's on record.
      const res = await postJSON("/challenge/rename", { name: n, visitorId, gid: runGid.current, ownerKey: ownerKeyIfCrowned() });
      if (!res.ok) return { ok: false, error: "Couldn't update your name — check your connection and try again." };
      return { ok: true, name: n };
    },
    [visitorId],
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
    geoMode, geoErr, reportFlagsUnavailable, remOn, mapEl, missed, missedOpen, setMissedOpen, between, done, countdown,
    joinInfo, joinName, setJoinName, joinErr, setJoinErr,
    saveErr, retryPendingResult,
    resumeInfo, resumeRun, dismissResume,
    flagSel, selectFlag: setFlagSel, moveFlagSel, namedIds: named.current,
    // actions
    initCreate, initJoin, initDaily, createChallenge, startSolo, startGeoChallenge, startPlaying, startJoin, runCountdown,
    startRound, submit, noteTyping, giveUp, nextRound, toggleRemaining, backToStart, leaveRun, challengeUrl, submitDaily, renameRun,
    todayEastern,
  };
}
