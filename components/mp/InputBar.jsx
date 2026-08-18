"use client";
import { useReplay } from "@/hooks/useReplay";
import { cx } from "@/lib/browser/cx";

// One box for two jobs, with a pill that always says which: an ANSWER goes to the game, a
// CHAT message goes to the room. "/" or the 💬 button flips between them.
export default function InputBar({ mp, view }) {
  const chat = mp.chatMode;
  const answerMode = view.enable && !chat;
  const [shaking, endShake] = useReplay(mp.inputShake);

  return (
    <div
      className={cx(
        "flex items-center gap-2 border-t-[3px] px-3 py-2 transition-[background,border-color] duration-150 desk:px-5 desk:py-3",
        chat ? "border-t-accent2 bg-[rgba(62,207,142,.12)]" : answerMode ? "border-t-accent bg-panel2" : "border-t-line bg-panel2",
      )}
    >
      {chat || answerMode ? (
        <span
          className={cx(
            "flex items-center rounded-lg px-[9px] py-[5px] text-xs font-extrabold tracking-[.5px] whitespace-nowrap",
            chat ? "bg-accent2 text-onaccent2" : "bg-accent text-markfg",
          )}
        >
          {chat ? "CHAT" : "ANSWER"}
        </span>
      ) : null}

      {/* On mobile the auto chat-mode switch covers this, so the button only shows on desktop. */}
      <button
        type="button"
        title="Chat (or press /)"
        onClick={mp.toggleChat}
        className={cx(
          "hidden shrink-0 cursor-pointer rounded-[10px] border px-[13px] py-[13px] text-lg font-extrabold desk:block",
          chat ? "border-accent2 bg-accent2 text-onaccent2" : "border-line bg-panel2 text-ink hover:border-accent hover:bg-accent",
        )}
      >
        💬
      </button>

      <input
        ref={mp.inputEl}
        autoComplete="off"
        value={mp.inputValue}
        placeholder={chat ? "Message…  (Enter to send, Esc or / to close)" : view.placeholder}
        disabled={mp.isGhost}
        onChange={(e) => mp.onInputChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") mp.send();
          else if (e.key === "Escape" && chat) mp.exitChat();
        }}
        onAnimationEnd={endShake}
        className={cx(
          "min-w-0 flex-1 rounded-[10px] border px-[13px] py-[11px] text-base text-ink outline-none desk:text-sm",
          shaking && "animate-shake border-bad!",
          chat
            ? "border-accent2 bg-[rgba(62,207,142,.10)]"
            : view.openingCue
              ? "border-bad bg-[rgba(229,72,77,.07)] shadow-[0_0_0_3px_rgba(229,72,77,.35)]"
              : "border-line bg-bg focus:border-accent",
        )}
      />

      <button
        type="button"
        onClick={mp.send}
        onMouseDown={(e) => e.preventDefault()} /* keep the keyboard open after sending */
        disabled={mp.isGhost}
        className={cx(
          "cursor-pointer rounded-[10px] border-none px-[18px] py-[11px] font-bold disabled:cursor-not-allowed disabled:opacity-40",
          chat ? "bg-accent2 text-onaccent2" : "bg-accent text-white",
        )}
      >
        Send
      </button>
    </div>
  );
}
