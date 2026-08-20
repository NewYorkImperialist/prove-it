"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSocketCtx } from "@/components/SocketProvider";
import { useStateRef } from "@/hooks/useStateRef";
import { sfx, setMuted as setSfxMuted } from "@/lib/browser/sfx";
import { emojify } from "@/lib/emoji";
import { duelAutoMode } from "@/lib/duel-view";
import { raceClockDeadline } from "@/lib/race-view";
import { PROMPT_MS } from "@/components/mp/PromptPop";
import * as store from "@/lib/browser/storage";

let feedSeq = 0;
const nextId = () => ++feedSeq;

// The whole realtime client: identity, room/lobby, both game modes, the message feed, chat
// and the settings each surface can change. One hook, mounted once by AppShell — the screens
// below it are presentational and call these actions.
export function useMultiplayer({ router }) {
  const { socket } = useSocketCtx();

  /* ---------------- identity ---------------- */
  // playerId survives a refresh (so we reconnect into our seat) but a fresh or duplicated
  // tab gets a new one, otherwise two tabs in one browser would fight over one slot.
  const identity = useRef(null);
  if (!identity.current) {
    const isReload = typeof window === "undefined" ? false : store.wasReload();
    identity.current = { isReload, playerId: typeof window === "undefined" ? "" : store.sessionPlayerId(isReload) };
  }
  const playerId = identity.current.playerId;

  const myIdRef = useRef(playerId);
  const [myRoom, setMyRoom, myRoomRef] = useStateRef(null);
  const [isSpectator, setIsSpectator, isSpectatorRef] = useStateRef(false);
  const [isGhost, setIsGhost, isGhostRef] = useStateRef(false);

  /* ---------------- room + game state ---------------- */
  const [room, setRoom] = useState(null); // last roomState snapshot
  const [gs, setGs, gsRef] = useStateRef(null); // duel snapshot
  const [raceGs, setRaceGs, raceGsRef] = useStateRef(null); // Challenge Race snapshot
  const [mode, setMode, modeRef] = useStateRef("duel"); // a room is one mode or the other
  const [iAmHost, setIAmHost, iAmHostRef] = useStateRef(false);
  const [feed, setFeed] = useState([]);
  const [typingBy, setTypingBy] = useState(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  // What *I* have named this race round, for the geography board. Opponents' answers never
  // arrive until the reveal, so this can only ever be my own.
  const [raceMine, setRaceMine, raceMineRef] = useStateRef({ round: 0, got: [] });

  /* ---------------- transient UI ---------------- */
  const [errors, setErrors] = useState({ home: "", race: "", room: "" });
  const [flash, setFlash] = useState(null); // one-off status line (a rejected action, mostly)
  const [prompt, setPrompt] = useState(null); // big centre-screen category reveal
  const [fx, setFx] = useState({ confetti: 0, oil: 0, logoParty: 0, crownParty: 0 });
  const [quickMatch, setQuickMatch] = useState({ inQueue: false, status: "" });
  const [muted, setMutedState] = useState(false);
  const [crown, setCrown] = useState({ hasKey: false, on: false });

  /* ---------------- chat mode ---------------- */
  const [chatMode, setChatMode, chatModeRef] = useStateRef(false);
  const chatDraft = useRef("");
  const [inputValue, setInputValue, inputValueRef] = useStateRef("");
  const [inputShake, setInputShake] = useState(0);
  const lastSendAt = useRef(0);
  const inputEl = useRef(null);

  const setErr = useCallback((key, msg) => setErrors((e) => ({ ...e, [key]: msg })), []);
  const flashStatus = useCallback((msg) => setFlash(msg), []);
  const shakeInput = useCallback(() => setInputShake((n) => n + 1), []);

  /* ---------------- session bookkeeping ---------------- */
  const rememberRoom = useCallback(
    (code) => {
      setMyRoom(code);
      store.setSessionRoom(code);
      if (!code) {
        store.setSessionSpectator(false);
        setIsSpectator(false);
        prevPlayers.current = null;
      }
    },
    [setMyRoom, setIsSpectator],
  );
  const rememberSpectator = useCallback(
    (on) => {
      setIsSpectator(on);
      store.setSessionSpectator(on);
    },
    [setIsSpectator],
  );

  /* ---------------- sound + crown preferences ---------------- */
  useEffect(() => {
    const m = store.getMutedPref();
    setMutedState(m);
    setSfxMuted(m);
    setCrown({ hasKey: !!store.getOwnerKey(), on: store.getCrownOn() });
  }, []);

  const toggleMuted = useCallback(() => {
    setMutedState((prev) => {
      const next = !prev;
      setSfxMuted(next);
      store.setMutedPref(next);
      if (!next) sfx.pop();
      return next;
    });
  }, []);

  // The crown key is validated by the server on every toggle, so it stays exclusive.
  const applyCrown = useCallback(() => {
    const key = store.getOwnerKey();
    if (key) socket.emit("setCrown", { on: store.getCrownOn(), key });
  }, [socket]);

  const toggleCrown = useCallback(() => {
    if (!store.getOwnerKey()) return;
    const next = !store.getCrownOn();
    store.setCrownOn(next);
    setCrown({ hasKey: true, on: next });
    applyCrown();
  }, [applyCrown]);

  /* ---------------- feed helpers ---------------- */
  const pushFeed = useCallback((entry) => setFeed((f) => [...f, { id: nextId(), ...entry }]), []);
  const clearFeed = useCallback(() => setFeed([]), []);
  // Last known player count, so a new arrival chimes but the first snapshot doesn't.
  const prevPlayers = useRef(null);

  /* ---------------- names ---------------- */
  const [mpName, setMpName] = useState("");
  const [raceName, setRaceName] = useState("");
  useEffect(() => {
    const saved = store.getMpName();
    if (saved) {
      setMpName(saved);
      setRaceName(saved);
    }
  }, []);
  const rememberName = useCallback((n) => store.setMpName(n), []);

  /* ---------------- URL parameters (invite / spectate / ghost / crown) ---------------- */
  const urlRef = useRef(null);
  if (!urlRef.current) {
    const clean = (v) => String(v || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4);
    const params = typeof window === "undefined" ? new URLSearchParams() : new URLSearchParams(window.location.search);
    urlRef.current = {
      invite: clean(params.get("room")),
      spectate: clean(params.get("spectate")),
      ghost: clean(params.get("ghost")),
      ghostKey: params.get("key") || "",
      crown: params.get("crown"),
    };
  }
  const url = urlRef.current;
  const [joinCode, setJoinCode] = useState(url.invite || "");
  const [raceJoinCode, setRaceJoinCode] = useState("");
  const triedInvite = useRef(false);

  // Become the owner once by visiting ?crown=YOUR_SECRET_KEY (?crown=off revokes it).
  useEffect(() => {
    if (url.crown == null) return;
    if (url.crown === "off") {
      store.setOwnerKey(null);
      store.setCrownOn(false);
    } else {
      store.setOwnerKey(url.crown);
      store.setCrownOn(true);
    }
    setCrown({ hasKey: !!store.getOwnerKey(), on: store.getCrownOn() });
    const u = new URL(window.location.href);
    u.searchParams.delete("crown");
    window.history.replaceState({}, "", u.pathname + u.search);
  }, [url.crown]);

  // An invite link lands straight on the multiplayer setup card — once, on boot. (The router
  // identity changes with the view, so without the guard this would drag you back here.)
  const bootedInvite = useRef(false);
  useEffect(() => {
    if (bootedInvite.current || !url.invite) return;
    bootedInvite.current = true;
    router.go("mpsetup");
  }, [url.invite, router]);

  /* ---------------- entering a room ---------------- */
  const enterRoom = useCallback(
    (res, { name } = {}) => {
      myIdRef.current = res.you;
      rememberRoom(res.code);
      // The server decides the role, not our request: "spectateRoom" on a code you still hold a
      // seat in resumes you as a PLAYER (rooms.js doResume), and so does joinRoom on your own
      // code. Trusting our own intent here would leave a seated player in the read-only
      // spectator UI — unable to open, raise, call or answer — until their turns timed out.
      rememberSpectator(!!res.spectator);
      if (name) rememberName(name);
      router.go(res.inGame ? "game" : "room");
      applyCrown();
    },
    [rememberRoom, rememberSpectator, rememberName, router, applyCrown],
  );

  const createRoom = useCallback(
    (name, roomMode) => {
      const key = roomMode === "race" ? "race" : "home";
      setErr(key, "");
      socket.emit("createRoom", { name, playerId, ...(roomMode === "race" ? { mode: "race" } : {}) }, (res) => {
        if (!res?.ok) return setErr(key, res?.error || "Could not create room.");
        enterRoom(res, { name });
      });
    },
    [socket, playerId, setErr, enterRoom],
  );

  const joinRoom = useCallback(
    (code, name, roomMode) => {
      const key = roomMode === "race" ? "race" : "home";
      setErr(key, "");
      const c = String(code || "").trim().toUpperCase();
      if (c.length < 4) return setErr(key, "Enter the 4-letter room code.");
      socket.emit("joinRoom", { code: c, name, playerId }, (res) => {
        if (!res?.ok) {
          const hint = roomMode === "race" ? " (not sure of the code?)" : " (tap Spectate to watch)";
          return setErr(key, (res?.error || "Could not join room.") + hint);
        }
        // Joining a code you already hold a seat in resumes that seat (rooms.js doResume), and
        // the ack says whether a match is live — overriding it with false dropped a returning
        // player into the waiting room while their match ran on without them.
        enterRoom(res, { name });
      });
    },
    [socket, playerId, setErr, enterRoom],
  );

  const spectateRoom = useCallback(
    (code, name) => {
      setErr("home", "");
      const c = String(code || "").trim().toUpperCase();
      if (c.length < 4) return setErr("home", "Enter the room code to spectate.");
      socket.emit("spectateRoom", { code: c, name, playerId }, (res) => {
        if (!res?.ok) return setErr("home", res?.error || "Could not spectate.");
        enterRoom(res, { name });
      });
    },
    [socket, playerId, setErr, enterRoom],
  );

  const leaveRoom = useCallback(() => {
    socket.emit("leaveRoom");
    rememberRoom(null);
    setGs(null);
    setRaceGs(null);
    router.go("home");
  }, [socket, rememberRoom, setGs, setRaceGs, router]);

  /* ---------------- quick match ---------------- */
  const leaveQuickMatch = useCallback(() => {
    setQuickMatch((q) => {
      if (q.inQueue) socket.emit("quickMatchLeave");
      return { inQueue: false, status: "" };
    });
  }, [socket]);

  const joinQuickMatch = useCallback(
    (name) => {
      setErr("race", "");
      socket.emit("quickMatchJoin", { name, playerId }, (res) => {
        if (!res?.ok) return setErr("race", res?.error || "Could not queue for quick match.");
        rememberName(name);
        setQuickMatch({ inQueue: true, status: "Waiting for other players…" });
      });
    },
    [socket, playerId, setErr, rememberName],
  );

  /* ---------------- settings ---------------- */
  const setSettings = useCallback((patch) => iAmHostRef.current && socket.emit("setSettings", patch), [socket, iAmHostRef]);
  const setRaceSettings = useCallback((patch) => iAmHostRef.current && socket.emit("raceSetSettings", patch), [socket, iAmHostRef]);
  const setGroupsNow = useCallback((groups) => socket.emit("setGroups", { groups }), [socket]);
  const setName = useCallback(
    (n) => {
      if (!n) return;
      rememberName(n);
      socket.emit("setName", { name: n });
    },
    [socket, rememberName],
  );
  const startMatch = useCallback(() => socket.emit("startMatch", {}, (r) => { if (!r?.ok) setErr("room", r?.error || "Could not start."); }), [socket, setErr]);

  /* ---------------- in-game actions ---------------- */
  const ackErr = useCallback((r) => { if (r && !r.ok && r.error) flashStatus(r.error); }, [flashStatus]);

  const runAction = useCallback(
    (action) => {
      switch (action) {
        case "leave": return leaveRoom();
        case "raise": return socket.emit("raise", {}, ackErr);
        case "proveIt": return socket.emit("proveIt", {}, ackErr);
        case "giveUp": return socket.emit("giveUp");
        case "nextRound": return socket.emit("nextRound");
        case "pauseRound": return socket.emit("pauseRound");
        case "voteEnd": return socket.emit("voteEnd");
        case "raceVoteEnd": return socket.emit("raceVoteEnd");
        case "rematch": return socket.emit("rematch", {}, ackErr);
        default: return undefined;
      }
    },
    [socket, ackErr, leaveRoom],
  );

  const judge = useCallback((answerId, accept) => socket.emit("judge", { answerId, accept }), [socket]);
  const rejectAll = useCallback(() => socket.emit("rejectAll"), [socket]);
  const revokeGrant = useCallback((grantId) => socket.emit("revokeGrant", { grantId }), [socket]);
  const voteSkip = useCallback(() => socket.emit("voteSkip"), [socket]);
  const approveMiss = useCallback((targetId, missId) => socket.emit("raceApproveMiss", { targetId, missId }), [socket]);

  /* ---------------- chat mode ---------------- */
  const typingActive = useRef(false);
  const typingTimer = useRef(null);
  const stopTyping = useCallback(() => {
    clearTimeout(typingTimer.current);
    if (typingActive.current) {
      typingActive.current = false;
      socket.emit("typing", { typing: false });
    }
  }, [socket]);
  const signalTyping = useCallback(() => {
    if (!chatModeRef.current) return;
    if (!typingActive.current) {
      typingActive.current = true;
      socket.emit("typing", { typing: true });
    }
    clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(stopTyping, 1500); // idle → stop
  }, [socket, chatModeRef, stopTyping]);

  // Restoring the draft is what makes Esc / "/" a toggle rather than a discard.
  const enterChat = useCallback(
    (focus = true) => {
      setChatMode(true);
      setInputValue(chatDraft.current);
      if (focus) requestAnimationFrame(() => inputEl.current?.focus());
      if (chatDraft.current) signalTyping();
    },
    [setChatMode, setInputValue, signalTyping],
  );
  const exitChat = useCallback(() => {
    chatDraft.current = inputValueRef.current;
    setChatMode(false);
    stopTyping();
    setInputValue("");
  }, [setChatMode, setInputValue, stopTyping, inputValueRef]);
  const toggleChat = useCallback(() => (chatModeRef.current ? exitChat() : enterChat()), [chatModeRef, exitChat, enterChat]);

  /* ---------------- sending ---------------- */
  const sendChat = useCallback((text) => { if (text) socket.emit("chat", { text: emojify(text) }); }, [socket]);

  const send = useCallback(() => {
    const raw = inputValueRef.current.trim();
    const isRace = modeRef.current === "race";
    if (isGhostRef.current) return setInputValue(""); // ghosts are silent · no chat, no actions

    if (isSpectatorRef.current || chatModeRef.current) {
      setInputValue("");
      if (chatModeRef.current) {
        chatDraft.current = "";
        setChatMode(false);
        stopTyping();
      }
      sendChat(raw);
      return;
    }
    if (!raw) return;
    if (raw[0] === "/") { // fallback: a "/"-prefixed message is chat
      setInputValue("");
      return sendChat(raw.slice(1).trim());
    }

    // A pause leaves the phase and the turn untouched, so without this the text below would be
    // classified as a game action, dropped by the server and cleared from the box — silently.
    // Keep it and say why, rather than routing it to chat: in a race that would broadcast an
    // answer to players who are still racing.
    if ((isRace ? raceGsRef.current : gsRef.current)?.paused) {
      shakeInput();
      flashStatus("The game is paused — press / to chat instead.");
      return; // the text stays put, so they can add the "/" themselves
    }

    if (isRace) {
      // No bidding and no turns: type an answer while the round is live, otherwise it's chat.
      const g = raceGsRef.current;
      if (!(g && g.phase === "live")) {
        setInputValue("");
        return sendChat(raw);
      }
      // My clock is spent but the round is still running for others. Don't send it as an answer
      // (the server would refuse it) and don't quietly turn it into chat either — that would
      // broadcast an answer to players who are still racing. Just say why nothing happened.
      const meNow = g.liveScores.find((p) => p.id === myIdRef.current);
      if (meNow && meNow.done) {
        shakeInput();
        flashStatus("You're out of time — press / to chat instead.");
        return; // the text stays put, so they can add the "/" themselves
      }
      setInputValue("");
      socket.emit("raceAnswer", { text: raw }, (res) => {
        if (res && res.accepted) {
          sfx.ding();
          const round = raceGsRef.current?.round ?? 0;
          setRaceMine((m) => (m.round === round ? { round, got: [...m.got, res.display] } : { round, got: [res.display] }));
          // clockMaxed: the answer counted but the round's clock ceiling ate the bonus, so say so
          // once rather than letting the timer look stuck.
          pushFeed({ type: "msg", side: "me", text: res.clockMaxed ? `${res.display} ✓ · clock maxed` : `${res.display} ✓`, kind: "ok" });
        } else if (res && res.alreadyHad) {
          pushFeed({ type: "msg", side: "me", text: `already got ${res.display}`, kind: "bad" });
        }
        // A plain miss is silent — the same quiet-miss feel as solo mode.
      });
      return;
    }

    const g = gsRef.current;
    const myMove = !!g && g.turnId === myIdRef.current;
    // Number mode: a plain number on your turn is the game action; anything else (text, or
    // not your turn) becomes a chat message rather than an error.
    if (g && (g.phase === "opening" || g.phase === "bidding")) {
      if (myMove && /^\d+$/.test(raw)) {
        const n = parseInt(raw, 10);
        setInputValue("");
        if (g.phase === "opening") socket.emit("open", { n }, ackErr);
        else socket.emit("raise", { toN: n }, ackErr);
        return;
      }
      setInputValue("");
      return sendChat(raw);
    }
    // Proving, on your turn: the text is your answer.
    if (g && g.phase === "proving" && myMove) {
      const now = Date.now();
      if (now - lastSendAt.current < 350) { // typed too fast
        shakeInput();
        flashStatus("Slow down!");
        return;
      }
      lastSendAt.current = now;
      setInputValue("");
      socket.emit("answer", { text: raw }, (res) => {
        if (res && !res.ok) {
          shakeInput();
          if (res.reason === "pending") {
            setInputValue(raw);
            flashStatus("Hold on · your opponent still has answers to rule.");
          } else if (res.reason === "roundcap") flashStatus("Too many off-list guesses this round.");
          else flashStatus("Slow down!");
        }
      });
      return;
    }
    // Anything else (waiting on your opponent, between rounds, match over…) → chat.
    setInputValue("");
    sendChat(raw);
  }, [socket, ackErr, flashStatus, shakeInput, sendChat, pushFeed, setInputValue, setChatMode, stopTyping,
      inputValueRef, modeRef, isGhostRef, isSpectatorRef, chatModeRef, raceGsRef, gsRef]);

  // A completed :shortcode: turns into its emoji as you type (no popup, just a swap).
  const onInputChange = useCallback(
    (v) => {
      setInputValue(emojify(v));
      if (chatModeRef.current) signalTyping();
    },
    [setInputValue, chatModeRef, signalTyping],
  );

  /* ---------------- socket wiring ---------------- */
  const promptTimer = useRef(null);
  const lastPromptKey = useRef(null);
  const prevActKey = useRef(null);
  const showPrompt = useCallback((cat) => {
    setPrompt({ label: `${cat.emoji} ${cat.group}`, name: cat.name, key: nextId() });
    clearTimeout(promptTimer.current);
    promptTimer.current = setTimeout(() => setPrompt(null), PROMPT_MS);
  }, []);

  useEffect(() => {
    // Shared by the duel's "log" and Challenge Race's "raceLog" — identical payloads.
    const handleLog = ({ by, name, text, kind }) => {
      if (kind === "ok") sfx.ding();
      else if (kind === "bad") sfx.buzz();
      else if (kind === "pending") sfx.pop();
      const side = by === "system" ? "system" : by === myIdRef.current ? "me" : "them";
      pushFeed({ type: "msg", side, name: side === "system" ? null : name, text, kind });
    };

    const onRoomState = (r) => {
      setMode(r.mode === "race" ? "race" : "duel");
      setRoom(r);
      setIAmHost(r.hostId === myIdRef.current);
      // Chime when someone new joins; the first snapshot is silent so you don't hear yourself.
      if (prevPlayers.current !== null && r.players.length > prevPlayers.current) sfx.join();
      prevPlayers.current = r.players.length;
      if (r.status === "waiting") router.go("room");
    };

    const onGameStarted = () => { clearFeed(); router.go("game"); };

    const onGameState = (state) => {
      const prev = gsRef.current;
      const phaseChanged = !prev || state.phase !== prev.phase;
      const turnMine = state.turnId === myIdRef.current && !state.paused &&
        (state.phase === "proving" || state.phase === "opening" || state.phase === "bidding");
      const prevTurnMine = !!prev && prev.turnId === myIdRef.current && !prev.paused &&
        (prev.phase === "proving" || prev.phase === "opening" || prev.phase === "bidding");

      setGs(state);
      setFlash(null);
      if (phaseChanged && prev) {
        if (state.phase === "matchover") sfx.fanfare();
        else if (state.phase === "roundover") sfx[state.lastResult && state.lastResult.winnerId === myIdRef.current ? "roundWin" : "roundLose"]();
      } else if (phaseChanged && state.phase === "matchover") sfx.fanfare();
      if (turnMine && !prevTurnMine) sfx.pop(); // a soft cue when it becomes your turn

      // Big centre-screen reveal of the category, once per round, during the opening.
      const key = state.round + "|" + state.category.name;
      if (state.phase === "opening" && key !== lastPromptKey.current) {
        lastPromptKey.current = key;
        showPrompt(state.category);
      }
      // Auto-switch the input on each turn/phase transition: my move → ANSWER mode, my
      // opponent guessing → CHAT mode (I can't answer then, only chat).
      const actKey = state.phase + ":" + (state.turnId === myIdRef.current);
      if (!isSpectatorRef.current && actKey !== prevActKey.current) {
        const want = duelAutoMode(state, myIdRef.current);
        if (want === "answer" && chatModeRef.current) {
          chatDraft.current = inputValueRef.current;
          setChatMode(false);
          stopTyping();
          setInputValue("");
        } else if (want === "chat" && !chatModeRef.current) {
          enterChat(false); // no focus grab: don't pop their keyboard unprompted
        }
      }
      prevActKey.current = actKey;
    };

    const onRaceState = (state) => {
      // A new round wipes my answer list, so the board starts empty rather than carrying over.
      if (raceMineRef.current.round !== state.round) setRaceMine({ round: state.round, got: [] });
      setRaceGs(state);
      setFlash(null);
      const key = state.round + "|" + (state.category ? state.category.name : "");
      if (state.phase === "countdown" && state.category && key !== lastPromptKey.current) {
        lastPromptKey.current = key;
        showPrompt(state.category);
      }
    };

    // Round-end reveal (race only). Fires several times per round: once opening the review
    // window, again on each approved miss, and last when the result is final — all updating
    // the SAME card rather than piling up duplicates.
    const onRaceReveal = (r) => {
      setReviewOpen(!r.final);
      setFeed((f) => {
        const i = f.findIndex((e) => e.type === "reveal" && e.round === r.round);
        const entry = { id: i >= 0 ? f[i].id : nextId(), type: "reveal", round: r.round, reveal: r };
        if (i >= 0) return f.map((e, j) => (j === i ? entry : e));
        return [...f, entry];
      });
      if (r.final) sfx[r.roundWinnerIds.includes(myIdRef.current) ? "roundWin" : r.tie ? "pop" : "roundLose"]();
    };

    const onRaceMatchOver = (payload) => {
      sfx.fanfare();
      const ranked = payload.roundWins.slice().sort((a, b) => b.wins - a.wins);
      const line = ranked.map((p) => `${p.name} ${p.wins}`).join(" · ");
      const summary = payload.winnerId
        ? `${(ranked.find((p) => p.id === payload.winnerId) || {}).name} wins the match! (${line})`
        : `Match over — it's a tie! (${line})`;
      pushFeed({ type: "msg", side: "system", text: summary, kind: null });
    };

    const onChat = ({ id, name, text }) => {
      setTypingBy(null); // they sent it → no longer typing
      pushFeed({ type: "chat", mine: id === myIdRef.current, name, text });
    };

    const onTyping = ({ name, typing }) => setTypingBy(typing ? name : null);

    const onOpponentLeft = ({ name }) => {
      setGs(null);
      window.alert(`${name} left the game.`);
      router.go("room");
    };

    const onRoomClosed = () => {
      setGs(null);
      setRaceGs(null);
      rememberRoom(null);
      // Land on the setup card that actually renders this error, not the menu — errors.home only
      // shows on the multiplayer card and errors.race only on the race card, so sending someone
      // to "home" means the explanation is never seen.
      const race = modeRef.current === "race";
      router.go(race ? "racesetup" : "mpsetup");
      setErr(race ? "race" : "home", "This room was closed.");
    };

    const onOpponentStatus = ({ connected, name }) => { if (connected) flashStatus(`${name} reconnected.`); };

    // 🎯 Someone said the magic words → +5 and a party for everyone.
    const onEasterEgg = ({ name, phrase, fx: effect }) => {
      if (effect === "oil") {
        setFx((f) => ({ ...f, oil: f.oil + 1 }));
        sfx.sparkle();
        flashStatus(`${name} said "${phrase}" · oil incoming!`);
        return;
      }
      sfx.sparkle();
      setFx((f) => ({
        ...f,
        confetti: f.confetti + 1,
        ...(effect === "crown" ? { crownParty: f.crownParty + 1 } : { logoParty: f.logoParty + 1 }),
      }));
      flashStatus(`${name} said "${phrase || "the magic words"}" · +5 bonus points!`);
    };

    const onQuickMatchStatus = ({ waiting, startsInMs }) =>
      setQuickMatch((q) =>
        q.inQueue
          ? {
              inQueue: true,
              status: startsInMs != null
                ? `${waiting} waiting · starting in ${Math.ceil(startsInMs / 1000)}s…`
                : `${waiting} waiting for at least one more player…`,
            }
          : q,
      );

    const onQuickMatchFound = ({ code, you }) => {
      setQuickMatch({ inQueue: false, status: "" });
      myIdRef.current = you || myIdRef.current;
      rememberRoom(code);
      router.go("room");
      applyCrown();
    };

    // Reconnect / deep-link resolution, re-run on every connect so a ghost never silently
    // falls back to a visible spectator after a refresh.
    const onConnect = () => {
      if (url.ghost) {
        socket.emit("ghostWatch", { code: url.ghost, key: url.ghostKey }, (res) => {
          if (!res?.ok) {
            // The multiplayer card is where errors.home renders, and it has the room-code field
            // they'd want next — a deep link can be for either mode, so it's the honest landing.
            router.go("mpsetup");
            return setErr("home", res?.error || "Could not ghost-watch.");
          }
          setIsGhost(true);
          setIsSpectator(true);
          myIdRef.current = res.you;
          router.go(res.inGame ? "game" : "room");
        });
        return;
      }
      const code = myRoomRef.current;
      if (code && isSpectatorRef.current) {
        socket.emit("spectateRoom", { code, name: store.getMpName(), playerId }, (res) => {
          if (!res?.ok) {
            rememberRoom(null);
            router.go("home");
          } else {
            myIdRef.current = res.you;
            router.go(res.inGame ? "game" : "room");
          }
        });
      } else if (code) {
        socket.emit("resume", { code, playerId }, (res) => {
          if (!res?.ok) { // room gone → back to the start
            rememberRoom(null);
            router.go("home");
            maybeAutoJoinInvite();
          } else {
            // A reload builds this hook from scratch, so re-adopt our identity and go where the
            // server says we are. Without this a refresh mid-match left the player on the home
            // menu while the server silently re-claimed their seat: unpaused, still on the
            // clock, losing every turn by timeout. The spectator and ghost branches route the
            // same way — this one used to be the odd one out.
            myIdRef.current = res.you;
            router.go(res.inGame ? "game" : "room");
            applyCrown();
          }
        });
      } else if (url.spectate) {
        socket.emit("spectateRoom", { code: url.spectate, name: store.getMpName(), playerId }, (res) => {
          if (!res?.ok) {
            router.go("mpsetup");
            return setErr("home", res?.error || "Could not spectate.");
          }
          myIdRef.current = res.you;
          rememberRoom(res.code);
          rememberSpectator(true);
          router.go(res.inGame ? "game" : "room");
          window.history.replaceState({}, "", window.location.pathname);
        });
      } else maybeAutoJoinInvite();
    };

    function maybeAutoJoinInvite() {
      if (triedInvite.current || !url.invite || myRoomRef.current) return;
      triedInvite.current = true;
      socket.emit("joinRoom", { code: url.invite, name: store.getMpName(), playerId }, (res) => {
        if (!res?.ok) return; // room gone/full → stay on the setup card with the code prefilled
        myIdRef.current = res.you;
        rememberRoom(res.code);
        router.go("room");
        applyCrown();
        window.history.replaceState({}, "", window.location.pathname); // a refresh resumes normally
      });
    }

    const handlers = {
      connect: onConnect,
      roomState: onRoomState,
      gameStarted: onGameStarted,
      raceGameStarted: onGameStarted,
      gameState: onGameState,
      raceState: onRaceState,
      log: handleLog,
      raceLog: handleLog,
      raceReveal: onRaceReveal,
      raceMatchOver: onRaceMatchOver,
      chat: onChat,
      typing: onTyping,
      opponentLeft: onOpponentLeft,
      opponentStatus: onOpponentStatus,
      roomClosed: onRoomClosed,
      easterEgg: onEasterEgg,
      quickMatchStatus: onQuickMatchStatus,
      quickMatchFound: onQuickMatchFound,
    };
    for (const [ev, fn] of Object.entries(handlers)) socket.on(ev, fn);
    if (socket.connected) onConnect();
    return () => {
      for (const [ev, fn] of Object.entries(handlers)) socket.off(ev, fn);
    };
    // Registered once for the life of the tab: every value these handlers need that can change
    // is read through a ref or a stable setter, so there are no dependencies to track.
  }, []);

  /* ---------------- restore a room after a refresh ---------------- */
  useEffect(() => {
    if (!identity.current.isReload) {
      store.setSessionRoom(null);
      store.setSessionSpectator(false);
      return;
    }
    const code = store.getSessionRoom();
    if (code) {
      setMyRoom(code);
      setIsSpectator(store.getSessionSpectator());
    }
  }, [setMyRoom, setIsSpectator]);

  /* ---------------- server-driven countdown ---------------- */
  // Both modes carry a server-authoritative `deadline`; the clock is rendered from it, so a
  // laggy client can't drift.
  const [clock, setClock] = useState({ left: null, danger: false });
  const lastTickSec = useRef(null);
  useEffect(() => {
    const iv = setInterval(() => {
      const isRace = modeRef.current === "race";
      const state = isRace ? raceGsRef.current : gsRef.current;
      // A race gives every player their own clock, so count down to mine (a spectator, or
      // anyone whose clock is already spent, follows the last one still running).
      const deadline = state ? (isRace ? raceClockDeadline(state, myIdRef.current) : state.deadline) : null;
      if (!state || !deadline || state.paused) {
        lastTickSec.current = null;
        return setClock((c) => (c.left == null ? c : { left: null, danger: false }));
      }
      const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      const danger = isRace ? left <= 5 : state.phase === "proving" ? left <= 10 : left <= 3;
      setClock((c) => (c.left === left && c.danger === danger ? c : { left, danger }));
      // Tick the final 5 seconds, hotter in the last 3.
      if (left <= 5 && left >= 1 && left !== lastTickSec.current) {
        lastTickSec.current = left;
        (left <= 3 ? sfx.tickHot : sfx.tick)();
      } else if (left > 5) lastTickSec.current = null;
    }, 250);
    return () => clearInterval(iv);
  }, [modeRef, raceGsRef, gsRef]);

  /* ---------------- global keys ---------------- */
  useEffect(() => {
    const onKey = (e) => {
      if (router.view !== "game") return;
      // "/" anywhere toggles chat, keeping the draft — but never clobbers a half-typed answer.
      if (e.key === "/") {
        if (chatModeRef.current) {
          e.preventDefault();
          return exitChat();
        }
        if (document.activeElement === inputEl.current && inputValueRef.current.trim() !== "") return;
        e.preventDefault();
        return enterChat();
      }
      // "P" between rounds advances (when auto-advance is off, or while paused).
      if (e.key === "p" || e.key === "P") {
        if (chatModeRef.current) return;
        if (document.activeElement === inputEl.current && inputValueRef.current.trim() !== "") return;
        const g = gsRef.current;
        if (!g || g.phase !== "roundover" || !g.intermission || g.paused) return;
        e.preventDefault();
        socket.emit("nextRound");
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [router.view, socket, exitChat, enterChat, chatModeRef, inputValueRef, gsRef]);

  return {
    // identity + session
    playerId, myId: myIdRef.current, myRoom, isSpectator, isGhost,
    // state
    room, gs, raceGs, mode, iAmHost, feed, typingBy, reviewOpen, clock, prompt, fx, raceMine,
    errors, flash, quickMatch, muted, crown,
    // names + codes bound to the setup cards
    mpName, setMpName, raceName, setRaceName, joinCode, setJoinCode, raceJoinCode, setRaceJoinCode,
    // lobby actions
    createRoom, joinRoom, spectateRoom, leaveRoom, startMatch, joinQuickMatch, leaveQuickMatch,
    setSettings, setRaceSettings, setGroupsNow, setName, rememberName, setErr,
    // game actions
    runAction, judge, rejectAll, revokeGrant, voteSkip, approveMiss,
    // input
    inputValue, onInputChange, send, inputShake, shakeInput, inputEl, chatMode, toggleChat, exitChat,
    // misc
    toggleMuted, toggleCrown, flashStatus,
  };
}
