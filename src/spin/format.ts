// Display helpers for the /spin minigame: big-number abbreviation, chance and
// duration formatting. Values reach ~1e24 (Card at top tier), so the suffix
// table runs deep and falls back to scientific notation.

const SUFFIXES = ['', 'k', 'm', 'b', 't', 'qa', 'qi', 'sx', 'sp', 'oc', 'no', 'dc'];

/** Abbreviate a value: 1234 -> "1.23k", -4.1e24 -> "-4.1sp", beyond -> "1.2e40". */
export function fmtValue(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  const sign = v < 0 ? '-' : '';
  const abs = Math.abs(v);
  if (abs < 1000) {
    return sign + (Number.isInteger(abs) ? String(abs) : abs.toFixed(2).replace(/\.?0+$/, ''));
  }
  const mag = Math.floor(Math.log10(abs) / 3);
  if (mag >= SUFFIXES.length) return sign + abs.toExponential(2);
  const scaled = abs / Math.pow(10, mag * 3);
  const digits = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
  return sign + scaled.toFixed(digits) + SUFFIXES[mag];
}

/** Signed form for pull values: "+1.2m" / "-666k". */
export function fmtSigned(v: number): string {
  return (v >= 0 ? '+' : '') + fmtValue(v);
}

/** Luck multipliers: exact to 2dp when small, abbreviated when huge ("x30k"). */
export function fmtMult(m: number): string {
  return m < 1000 ? m.toFixed(2).replace(/\.?0+$/, '') : fmtValue(m);
}

/** "33.3% (1 in 3)" — for the odds table. */
export function fmtChance(p: number): string {
  if (p <= 0) return 'disabled';
  const pct =
    p >= 0.01 ? (p * 100).toFixed(1) : p >= 0.0001 ? (p * 100).toFixed(3) : (p * 100).toExponential(1);
  const oneIn = 1 / p;
  const oneInStr = oneIn >= 100 ? fmtValue(Math.round(oneIn)) : oneIn.toFixed(1).replace(/\.0$/, '');
  return `${pct}% (1 in ${oneInStr})`;
}

/** Parse "90", "90s", "3m", "1h", "1h30m", "2d" into ms (bare number = seconds). */
export function parseDuration(input: string): number | null {
  const s = input.trim().toLowerCase();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000);
  const re = /(\d+(?:\.\d+)?)\s*(d|h|m|s)/g;
  let ms = 0;
  let matched = false;
  for (const m of s.matchAll(re)) {
    matched = true;
    const n = Number(m[1]);
    ms += n * { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000 }[m[2] as 'd' | 'h' | 'm' | 's'];
  }
  return matched ? Math.round(ms) : null;
}

/** "3m", "1h 30m", "45s" from ms. */
export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const units: Array<[string, number]> = [['d', 86_400_000], ['h', 3_600_000], ['m', 60_000], ['s', 1000]];
  const parts: string[] = [];
  let rest = ms;
  for (const [name, size] of units) {
    const n = Math.floor(rest / size);
    if (n > 0) {
      parts.push(`${n}${name}`);
      rest -= n * size;
    }
  }
  return parts.slice(0, 2).join(' ') || '0s';
}

/** Split lines into chunks that fit an embed description. */
export function chunkLines(lines: string[], max = 3800): string[] {
  const chunks: string[] = [];
  let cur = '';
  for (const line of lines) {
    if (cur.length + line.length + 1 > max && cur) {
      chunks.push(cur);
      cur = '';
    }
    cur += (cur ? '\n' : '') + line;
  }
  if (cur) chunks.push(cur);
  return chunks;
}
