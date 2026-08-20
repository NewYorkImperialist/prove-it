// Thin JSON fetch helpers. Both resolve to { ok: false } on a network failure so callers
// can render "couldn't load that" instead of throwing into a dead screen. `fallback` is for
// the callers where "we couldn't ask" must not read as a "no" from the server.
export async function getJSON(url, fallback = { ok: false }) {
  try {
    return await (await fetch(url)).json();
  } catch {
    return fallback;
  }
}

export async function postJSON(url, body) {
  try {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return await r.json();
  } catch {
    return { ok: false };
  }
}

// Ask the server whether a name is profanity/slur-blocked (/name-check answers ok:true for an
// allowed name, ok:false for a blocked one). Fails open on a network hiccup — the default
// { ok: false } would have been read as "blocked", telling a player their perfectly clean name
// isn't allowed because one request dropped. The server's cleanName() is the real backstop.
export async function isNameBlocked(name) {
  const d = await getJSON(`/name-check?name=${encodeURIComponent(name)}`, { ok: true });
  return !!d && d.ok === false;
}
