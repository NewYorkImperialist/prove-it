"use client";

// Off-list answers awaiting a ruling. The challenger (the judge) gets Accept/Reject plus a
// Reject-all shortcut; the prover just sees that they're pending.
const ROW = "flex items-center gap-2 rounded-[10px] border px-2.5 py-2";
// Accept and Reject do opposite things to someone else's round and used to be 34px tall with an
// 8px gap between them — a mis-tap on a phone was one thumb-width away, and it isn't undoable.
const BTN = "min-h-11 shrink-0 cursor-pointer rounded-lg border-none px-3 py-[7px] text-[13px] font-bold";

function JudgeRow({ answer, onJudge }) {
  return (
    <div className={`${ROW} border-gold bg-[rgba(255,207,91,.12)]`}>
      <span className="min-w-0 flex-1 truncate font-bold">{answer.text}</span>
      <button type="button" className={`${BTN} bg-accent2 text-onaccent2`} onClick={() => onJudge(answer.id, true)}>
        ✓ Accept
      </button>
      <button type="button" className={`${BTN} bg-bad text-white`} onClick={() => onJudge(answer.id, false)}>
        ✗ Reject
      </button>
    </div>
  );
}

// An off-list answer already granted this round — a distinct green look so it doesn't read as
// still-pending, with a way to undo it (they accepted "Nowray", then the prover also typed
// "Norway", which matched the real list entry and double-counted the item).
function GrantedRow({ grant, onRevoke }) {
  return (
    <div className={`${ROW} border-accent2 bg-[rgba(62,207,142,.12)]`}>
      <span className="flex-1 font-bold">{grant.text}</span>
      <button type="button" className={`${BTN} bg-bad text-white`} onClick={() => onRevoke(grant.id)}>
        Take back
      </button>
    </div>
  );
}

export default function PendingPanel({ gs, myId, onJudge, onRejectAll, onRevoke }) {
  const amJudge = gs.challengerId === myId;
  const rows = [];

  if (gs.phase === "proving") {
    // Live judging · the whole pending list at once.
    const pending = gs.pending || [];
    if (pending.length) {
      if (amJudge) {
        pending.forEach((p) => rows.push(<JudgeRow key={p.id} answer={p} onJudge={onJudge} />));
        if (pending.length > 1) rows.push(<RejectAll key="all" label="Reject all" onClick={onRejectAll} />);
      } else {
        rows.push(<Note key="note">Off-list, waiting on opponent: {pending.map((p) => p.text).join(", ")}</Note>);
      }
    }
  } else if (gs.phase === "judging") {
    // Forced ruling · one at a time.
    const a = gs.judgeActive;
    if (a) {
      if (amJudge) {
        rows.push(<JudgeRow key={a.id} answer={a} onJudge={onJudge} />);
        if (gs.judgeRemaining > 1) rows.push(<RejectAll key="all" label={`Reject remaining (${gs.judgeRemaining})`} onClick={onRejectAll} />);
      } else {
        rows.push(
          <Note key="note">
            Opponent ruling: “{a.text}” ({gs.judgeRemaining} left)
          </Note>,
        );
      }
    }
  }

  // Granted answers can be undone any time the round is still live — challenger only.
  if (amJudge && (gs.phase === "proving" || gs.phase === "judging") && gs.granted?.length) {
    gs.granted.forEach((gr) => rows.push(<GrantedRow key={`g${gr.id}`} grant={gr} onRevoke={onRevoke} />));
  }

  if (!rows.length) return null;
  return <div className="flex flex-col gap-1.5 px-3 desk:px-5">{rows}</div>;
}

function RejectAll({ label, onClick }) {
  return (
    <button type="button" onClick={onClick} className="min-h-9 cursor-pointer self-end border-none bg-transparent px-2 py-1 text-xs text-muted underline">
      {label}
    </button>
  );
}

function Note({ children }) {
  return <div className="p-0.5 text-[13px] text-gold">{children}</div>;
}
