"use client";

const PATHS = [
  "M6.55211 3.25C5.65611 5.69807 6.48402 7.13205 9.05211 7.58013C9.94812 5.13205 9.12021 3.69807 6.55211 3.25Z",
  "M3.05998 8.17912C2.82812 10.7757 3.99896 11.9465 6.59552 11.7147C6.82738 9.1181 5.65654 7.94726 3.05998 8.17912Z",
  "M2.67188 14.2992C3.11994 16.8673 4.55393 17.6952 7.002 16.7992C6.55393 14.2311 5.11995 13.4032 2.67188 14.2992Z",
  "M17.4506 3.25C18.3466 5.69807 17.5186 7.13205 14.9506 7.58013C14.0545 5.13205 14.8825 3.69807 17.4506 3.25Z",
  "M20.9315 8.17912C21.1633 10.7757 19.9925 11.9465 17.3959 11.7147C17.1641 9.1181 18.3349 7.94726 20.9315 8.17912Z",
  "M21.3301 14.2982C20.8821 16.8663 19.4481 17.6942 17 16.7982C17.4481 14.2301 18.8821 13.4022 21.3301 14.2982Z",
  "M7 16.7979C9.4429 19.4992 13.2165 18.7897 15.5 21.4992",
  "M17 16.7979C14.5571 19.4992 10.7835 18.7897 8.5 21.4992",
];

// The laurel wreath in the card's top-right corner — the way into the leaderboards.
export default function LaurelButton({ onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title="Leaderboards"
      aria-label="Leaderboards"
      className="ml-auto grid h-11 w-11 shrink-0 cursor-pointer place-items-center rounded-[11px] border border-line2 bg-panel2 p-0 text-gold transition duration-[140ms] hover:-translate-y-px hover:border-accent hover:text-accent"
    >
      <svg viewBox="0 0 24 24" fill="none" width="26" height="26" aria-hidden="true" className="block">
        {PATHS.map((d) => (
          <path key={d} d={d} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        ))}
      </svg>
    </button>
  );
}
