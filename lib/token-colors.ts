// Deterministic color assignment for formula reference badges — the same
// field name always renders in the same color everywhere (editor chips,
// hover preview), so a name can be visually tracked across formulas/cells.

const PALETTE = [
  { bg: 'bg-blue-100',     text: 'text-blue-800' },
  { bg: 'bg-purple-100',   text: 'text-purple-800' },
  { bg: 'bg-teal-100',     text: 'text-teal-800' },
  { bg: 'bg-pink-100',     text: 'text-pink-800' },
  { bg: 'bg-indigo-100',   text: 'text-indigo-800' },
  { bg: 'bg-cyan-100',     text: 'text-cyan-800' },
  { bg: 'bg-fuchsia-100',  text: 'text-fuchsia-800' },
  { bg: 'bg-violet-100',   text: 'text-violet-800' },
  { bg: 'bg-sky-100',      text: 'text-sky-800' },
  { bg: 'bg-lime-100',     text: 'text-lime-800' },
] as const;

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

/** Fixed bg/text Tailwind classes for a referenced field name (stable across calls). */
export function colorForName(name: string): { bg: string; text: string } {
  return PALETTE[hashString(name) % PALETTE.length];
}
