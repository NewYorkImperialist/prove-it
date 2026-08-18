// Join class names, dropping anything falsy. Small enough not to be worth a dependency.
export const cx = (...parts) => parts.filter(Boolean).join(" ");
