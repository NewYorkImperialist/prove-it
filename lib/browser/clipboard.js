// Copy to the clipboard, falling back to a hidden textarea + execCommand on browsers (and
// insecure contexts) where the async Clipboard API isn't available.
export async function copyText(str) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(str);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const t = document.createElement("textarea");
    t.value = str;
    t.style.position = "fixed";
    t.style.opacity = "0";
    document.body.appendChild(t);
    t.select();
    document.execCommand("copy");
    t.remove();
    return true;
  } catch {
    return false;
  }
}
