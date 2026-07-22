// Big-pull presentation. Three staff-set thresholds decide how loudly a spin is
// announced: ornaments around the title, a boxed rarity banner, reactions, a
// short suspense pause, and (top level only) an opt-in role ping. Pure — the
// commands pass in the tier and the thresholds, this decides how it looks.

import { rarities, TIER_RATIO } from './data.js';

export interface FlairStyle {
  /** 0 = plain spin, 1-3 = escalating flair levels. */
  level: number;
  /** Reactions added to the result message, in order. */
  reactions: readonly string[];
  /** Suspense pause before the result is revealed, in ms (0 = instant). */
  delayMs: number;
  /** Whether the ping role, if one is configured, should be notified. */
  ping: boolean;
}

const LEVELS: readonly FlairStyle[] = [
  { level: 0, reactions: [], delayMs: 0, ping: false },
  { level: 1, reactions: ['🎉'], delayMs: 0, ping: false },
  { level: 2, reactions: ['🔥', '💎'], delayMs: 1_500, ping: false },
  { level: 3, reactions: ['🌌', '✨', '👑'], delayMs: 3_000, ping: true },
];

/** Flair level a tier earns. Thresholds are lowest-first; a tier at or past
 *  several of them takes the highest one it clears. */
export function flairFor(tier: number, thresholds: readonly number[]): FlairStyle {
  let level = 0;
  for (let i = 0; i < thresholds.length && i < 3; i++) {
    if (tier >= thresholds[i]) level = i + 1;
  }
  return LEVELS[level];
}

// Level 1 keeps the "BIG PULL" wording players already know. Above it the
// ornaments and the banner carry the escalation instead of louder wording.
const ORNAMENTS: Record<number, { lead: string; left: string; right: string }> = {
  2: { lead: '🔥', left: '❖◈', right: '◈❖' },
  3: { lead: '🌌', left: '✵✷✦', right: '✦✷✵' },
};

/** Embed title for a pull at the given flair level. */
export function flairTitle(level: number, rarityName: string, petalName: string): string {
  if (level <= 0) return `${rarityName} ${petalName}`;
  if (level === 1) return `🎉 BIG PULL — ${rarityName} ${petalName}!`;
  const o = ORNAMENTS[Math.min(level, 3)];
  return `${o.lead} ${o.left} ${rarityName} ${petalName} ${o.right}`;
}

/** Boxed rarity name for level 2+, wrapped in a code block so the frame lines
 *  up — Discord renders embed text in a proportional font, where box-drawing
 *  characters do not align. Level 3 gets the heavy double frame. */
export function flairBanner(level: number, rarityName: string): string | null {
  if (level < 2) return null;
  const label = rarityName.toUpperCase().split('').join(' ');
  const heavy = level >= 3;
  const [tl, h, tr, v, bl, br] = heavy
    ? ['╔', '═', '╗', '║', '╚', '╝']
    : ['┌', '─', '┐', '│', '└', '┘'];
  const rule = h.repeat(label.length + 4); // two spaces of padding each side
  return ['```', tl + rule + tr, `${v}  ${label}  ${v}`, bl + rule + br, '```'].join('\n');
}

/** Odds of rolling this rarity or better, as "1 in 190,000". Uses base weights
 *  with staff overrides applied and luck excluded, so the number is a stable
 *  brag rather than something that shifts with the roller's clover stack. */
export function oddsText(tier: number, overrides: Record<number, number> = {}): string {
  let total = 0;
  let atOrAbove = 0;
  for (let i = 0; i < rarities.length; i++) {
    const w = Math.pow(TIER_RATIO, -i) * (overrides[i] ?? 1);
    total += w;
    if (i >= tier) atOrAbove += w;
  }
  if (atOrAbove <= 0) return 'impossible';
  return `1 in ${Math.round(total / atOrAbove).toLocaleString('en-US')}`;
}

/** Record callouts for a pull, read before the spin is written to the DB.
 *  A server record implies a personal best, so only the louder line shows. */
export function recordLines(tier: number, personalBest: number, serverBest: number): string[] {
  if (tier > serverBest) return ['👑 **SERVER RECORD** — nobody here has ever pulled this deep'];
  if (tier > personalBest) return ['🏆 **NEW PERSONAL BEST** — your deepest pull yet'];
  return [];
}
