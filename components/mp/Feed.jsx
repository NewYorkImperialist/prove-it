"use client";
import { cx } from "@/lib/browser/cx";
import RaceReveal from "./RaceReveal";

const KIND = {
  ok: "border border-accent2 bg-[rgba(62,207,142,.16)]",
  bad: "border border-bad bg-[rgba(255,91,110,.14)]",
  pending: "border border-gold bg-[rgba(255,207,91,.12)]",
};

const SIDE = {
  me: "self-end rounded-br-[4px] bg-[#2f5fd0]",
  them: "self-start rounded-bl-[4px] bg-panel2",
  system: "self-center bg-transparent text-xs text-muted italic",
};

function Message({ entry }) {
  return (
    <>
      {entry.name && entry.side !== "system" ? (
        <div className={cx("mx-1.5 mt-0.5 -mb-1 text-[11px] text-muted", entry.side === "me" ? "self-end" : "self-start")}>{entry.name}</div>
      ) : null}
      <div
        className={cx(
          "max-w-[88%] animate-bubble rounded-[13px] px-[13px] py-[9px] text-sm leading-[1.4] break-words desk:max-w-[78%]",
          SIDE[entry.side],
          entry.kind && KIND[entry.kind],
        )}
      >
        {entry.text}
      </div>
    </>
  );
}

// Chat is deliberately unlike the game bubbles (Protobowl-style), so a raise never reads as
// banter and vice versa.
function ChatLine({ entry }) {
  return (
    <div className="self-stretch rounded-md bg-[rgba(255,255,255,.035)] px-2 py-1 text-[13px] leading-[1.45]">
      <span className={cx("font-bold", entry.mine ? "text-accent2" : "text-[#8ab4ff]")}>{entry.name}: </span>
      <span>{entry.text}</span>
    </div>
  );
}

// The scrolling transcript: game events, chat, and (in a race) the round-end reveal cards.
// `compact` gives up the free space (for a geography board) and keeps only a scrolling strip.
export default function Feed({ feed, scrollRef, myId, onApproveMiss, compact }) {
  return (
    <div
      ref={scrollRef}
      className={cx(
        // A landscape phone is wide enough for `desk:` but only ~390px tall, so the roomy desktop
        // padding used to starve `flex-1` down to a single clipped 32px line. Tighter gaps and a
        // min-height floor keep the transcript readable there.
        "flex min-h-0 flex-col gap-[7px] overflow-y-auto px-3 py-[9px] desk:gap-[9px] desk:px-5 desk:py-4 short:gap-[7px] short:py-1.5",
        compact ? "max-h-[24vh] shrink-0 short:max-h-[30vh]" : "min-h-[60px] flex-1",
      )}
    >
      {feed.map((entry) =>
        entry.type === "chat" ? (
          <ChatLine key={entry.id} entry={entry} />
        ) : entry.type === "reveal" ? (
          <RaceReveal key={entry.id} reveal={entry.reveal} myId={myId} onApproveMiss={onApproveMiss} />
        ) : (
          <Message key={entry.id} entry={entry} />
        ),
      )}
    </div>
  );
}
