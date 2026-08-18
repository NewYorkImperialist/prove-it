// Thin JSON fetch helpers. Both resolve to { ok: false } on a network failure so callers
// can render "couldn't load that" instead of throwing into a dead screen.
export async function getJSON(url) {
  try {
    return await (await fetch(url)).json();
  } catch {
    return { ok: false };
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

// Ask the server whether a name is profanity/slur-blocked. Fails open on a network hiccup —
// the server still refuses to persist a bad name as a last-resort backstop.
export async function isNameBlocked(name) {
  const d = await getJSON(`/name-check?name=${encodeURIComponent(name)}`);
  return d && d.ok === false;
}
