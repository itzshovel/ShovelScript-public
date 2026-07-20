// Pure roll + reward logic for /spin. No Discord or DB imports; everything is
// parameterized (rng injectable) so it can be simulated and tested headlessly.
//
// Balance model (see tools/List of minigame petals.txt and CLAUDE-era spec):
// - Rarity tier: weight (1/1.5)^tier across the 69 usable tiers. Luck L softens
//   the ladder to ratio 1.5^(1/L) for that spin. Staff overrides multiply
//   individual tier weights.
// - Petal: static specials first (fixed chance, tier-gated, rarest checked
//   first), then a weighted pick over the pool at weight 1/|mult|.
// - Value: mult * R, where R follows the tuned piecewise curve in data.ts
//   (5 at tier 0 up to ~2.39b at tier 68), except Card 5*R^2, Cash 7.5*R^2 and
//   Shiny Cash 2 * R(highest tier ever) * R^2. Royal Serum triples missiles.

import {
  MISSILE_FAMILY,
  poolPetals,
  poolWeight,
  rarities,
  rarityValue,
  staticPetals,
  TIER_RATIO,
  type SpinPetal,
} from './data.js';
import type { EffectRow } from './db.js';

export type Rng = () => number;

const HOUR = 3_600_000;
export const STUN_MS = 6 * HOUR;
export const EGG_LUCK_MS = 18 * HOUR;
export const AURA_MS = 24 * HOUR; // radiance / shade / serum duration

export interface LuckResult {
  luck: number;
  /** One-shot effect rows (clover/token) consumed by this spin. */
  consumedIds: number[];
  /** Human-readable active parts, e.g. "Clover x10". */
  parts: string[];
}

/** Combine active luck effects at `now`: timed boosts stack additively, then
 *  one-shot boosts (clover, token) multiply the total and are consumed.
 *  `globalBoosts` (e.g. an active sacrifice) join the additive pool. */
export function computeLuck(
  effects: EffectRow[],
  now: number,
  globalBoosts: Array<{ label: string; mult: number }> = [],
): LuckResult {
  let additive = 1;
  let oneShot = 1;
  const consumedIds: number[] = [];
  const parts: string[] = [];

  for (const g of globalBoosts) {
    additive += g.mult - 1;
    parts.push(g.label);
  }

  for (const e of effects) {
    if (e.expiresMs === -1) {
      // one-shot: clover (x10) or token (x2-5), consumed on this spin
      oneShot *= e.mult;
      consumedIds.push(e.id);
      parts.push(`${e.kind === 'clover' ? 'Clover' : 'Token'} x${trim(e.mult)}`);
      continue;
    }
    if (now < e.startsMs || now >= e.expiresMs) continue;
    const progress = (now - e.startsMs) / (e.expiresMs - e.startsMs);
    let mult: number;
    switch (e.kind) {
      case 'radiance':
        mult = 1 + 9 * progress; // grows 1 -> 10 over 24h
        break;
      case 'shade':
        mult = 10 - 9 * progress; // decays 10 -> 1 over 24h
        break;
      case 'egg_luck':
        mult = e.mult; // flat 2x after the stun wears off
        break;
      default:
        continue; // serum is a value effect, not luck
    }
    additive += mult - 1;
    parts.push(`${label(e.kind)} x${trim(mult)}`);
  }

  return { luck: additive * oneShot, consumedIds, parts };
}

function label(kind: string): string {
  return { radiance: 'Radiance', shade: 'Shade', egg_luck: 'Egg luck' }[kind] ?? kind;
}

function trim(n: number): string {
  return n.toFixed(2).replace(/\.?0+$/, '');
}

/** Per-tier roll weights at luck L. Baseline weight is (1/1.5)^i; luck boosts
 *  a tier's relative likelihood by min(1.5^(i*(1-1/L)), L) — the curve softens
 *  with depth but is CLAMPED so no tier ever becomes more than Lx more likely
 *  than baseline ("x5 luck" = at most 5x the normal odds, deep tiers exactly
 *  5x). Staff overrides multiply on top (0 disables a tier). */
export function tierWeights(luck: number, overrides: Record<number, number> = {}): number[] {
  const L = Math.max(luck, 1);
  const soften = 1 - 1 / L;
  const weights: number[] = [];
  for (let i = 0; i < rarities.length; i++) {
    const boost = Math.min(Math.pow(TIER_RATIO, i * soften), L);
    weights.push(Math.pow(TIER_RATIO, -i) * boost * (overrides[i] ?? 1));
  }
  return weights;
}

/** Roll a rarity tier using the clamped-luck weights. */
export function rollTier(luck: number, overrides: Record<number, number>, rng: Rng): number {
  const weights = tierWeights(luck, overrides);
  let total = 0;
  for (const w of weights) total += w;
  let roll = rng() * total;
  for (let i = 0; i < weights.length; i++) {
    roll -= weights[i];
    if (roll < 0) return i;
  }
  return rarities.length - 1;
}

/** Pick the petal for a rolled tier: gated statics first (rarest first, each an
 *  independent chance), then the weighted pool. */
export function pickPetal(tier: number, rng: Rng): SpinPetal {
  for (const p of staticPetals) {
    if (tier >= p.static!.minTier && rng() < p.static!.chance) return p;
  }
  let total = 0;
  for (const p of poolPetals) total += poolWeight(p);
  let roll = rng() * total;
  for (const p of poolPetals) {
    roll -= poolWeight(p);
    if (roll < 0) return p;
  }
  return poolPetals[poolPetals.length - 1];
}

/** Reward value of a pull. highestTier is the user's best ever including this
 *  roll (Shiny Cash's formula references it). */
export function computeValue(
  petal: SpinPetal,
  tier: number,
  highestTier: number,
  serumActive: boolean,
): number {
  const R = rarityValue(tier);
  let value: number;
  switch (petal.valueKind) {
    case 'card':
      value = 5 * R * R;
      break;
    case 'cash':
      value = 7.5 * R * R;
      break;
    case 'shinycash':
      value = 2 * rarityValue(Math.max(highestTier, tier)) * R * R;
      break;
    default:
      value = petal.mult * R;
  }
  if (serumActive && MISSILE_FAMILY.has(petal.name)) value *= 3;
  return value;
}

export interface EffectOutcome {
  stunnedUntilMs: number; // 0 = no stun
  newEffects: Array<{ kind: string; mult: number; startsMs: number; expiresMs: number }>;
  /** Player-facing description of what the effect petal did. */
  note: string | null;
}

/** Side effects granted by effect petals (clover, token, plastic egg, radiance,
 *  shade, royal serum). */
export function resolveEffect(petal: SpinPetal, now: number, rng: Rng): EffectOutcome {
  switch (petal.effect) {
    case 'clover':
      return {
        stunnedUntilMs: 0,
        newEffects: [{ kind: 'clover', mult: 10, startsMs: now, expiresMs: -1 }],
        note: '🍀 10x luck on your next spin!',
      };
    case 'token': {
      const mult = 2 + rng() * 3; // random 2x-5x
      return {
        stunnedUntilMs: 0,
        newEffects: [{ kind: 'token', mult, startsMs: now, expiresMs: -1 }],
        note: `🪙 ${trim(mult)}x luck on your next spin!`,
      };
    }
    case 'stun': {
      const stunEnd = now + STUN_MS;
      return {
        stunnedUntilMs: stunEnd,
        newEffects: [{ kind: 'egg_luck', mult: 2, startsMs: stunEnd, expiresMs: stunEnd + EGG_LUCK_MS }],
        note: '🥚 Stunned! No spins for 6 hours, then 2x luck for 18 hours.',
      };
    }
    case 'radiance':
      return {
        stunnedUntilMs: 0,
        newEffects: [{ kind: 'radiance', mult: 1, startsMs: now, expiresMs: now + AURA_MS }],
        note: '✨ Luck grows from 1x to 10x over the next 24 hours.',
      };
    case 'shade':
      return {
        stunnedUntilMs: 0,
        newEffects: [{ kind: 'shade', mult: 1, startsMs: now, expiresMs: now + AURA_MS }],
        note: '🌑 10x luck right now, decaying to 1x over 24 hours.',
      };
    case 'serum':
      return {
        stunnedUntilMs: 0,
        newEffects: [{ kind: 'serum', mult: 3, startsMs: now, expiresMs: now + AURA_MS }],
        note: '🧪 Missiles are worth 3x for the next 24 hours.',
      };
    default:
      return { stunnedUntilMs: 0, newEffects: [], note: null };
  }
}

/** Whether a Royal Serum value boost is active at `now`. */
export function serumActive(effects: EffectRow[], now: number): boolean {
  return effects.some((e) => e.kind === 'serum' && now >= e.startsMs && now < e.expiresMs);
}

// --- sacrifice system ------------------------------------------------------

/** Fraction of a sacrifice's value redistributed back through boosted spins. */
export const SACRIFICE_REDIST = 0.8;
/** Luck beyond this adds nothing: the odds are already fully flat (every
 *  tier's clamp at Lx has disengaged). The solver pins here for sacrifices
 *  whose value no amount of luck can repay (jackpot pulls). */
export const SACRIFICE_LUCK_MAX = Math.pow(TIER_RATIO, rarities.length + 1);

/** Expected POOL pull value of one spin at luck L under the clamped model.
 *  Static specials are deliberately excluded: Card/Cash/Shiny Cash's squared
 *  and cubed value formulas ride on tiny fixed chances a boost window almost
 *  never sees, and including them would skew the calibration toward jackpots.
 *  Calibrating against the pool matches what a spin typically pays; the
 *  jackpot tail rides on top as a bonus. */
export function expectedValuePerSpin(luck: number): number {
  const weights = tierWeights(luck);
  let totalW = 0;
  for (const w of weights) totalW += w;

  let poolW = 0;
  let poolSigned = 0;
  for (const p of poolPetals) {
    const w = poolWeight(p);
    poolW += w;
    poolSigned += w * p.mult;
  }
  const poolMeanMult = poolSigned / poolW;

  let ev = 0;
  for (let i = 0; i < rarities.length; i++) {
    ev += (weights[i] / totalW) * poolMeanMult * rarityValue(i);
  }
  return ev;
}

/** Boost bought by sacrificing |value|: duration scales with log10 of the
 *  value, and the multiplier is solved (uncapped) so the boosted spins' extra
 *  expected value repays SACRIFICE_REDIST of it on average. Sacrifices no
 *  luck can repay (jackpot-grade values above what flat odds return over the
 *  boost window) pin at SACRIFICE_LUCK_MAX (fully flat odds). */
export function sacrificeBoost(absValue: number): { mult: number; spins: number } {
  const spins = Math.min(25, Math.max(3, 3 + 2 * Math.floor(Math.log10(1 + absValue))));
  const targetPerSpin = (SACRIFICE_REDIST * absValue) / spins;
  const base = expectedValuePerSpin(1);
  if (expectedValuePerSpin(SACRIFICE_LUCK_MAX) - base <= targetPerSpin) {
    return { mult: SACRIFICE_LUCK_MAX, spins };
  }
  let lo = 1;
  let hi = 2;
  while (expectedValuePerSpin(hi) - base < targetPerSpin) hi *= 2;
  for (let iter = 0; iter < 80; iter++) {
    const mid = (lo + hi) / 2;
    if (expectedValuePerSpin(mid) - base < targetPerSpin) lo = mid;
    else hi = mid;
  }
  return { mult: (lo + hi) / 2, spins };
}

/** Current tier odds (no luck), for /spinodds: probability per tier. */
export function tierOdds(overrides: Record<number, number>): number[] {
  const weights = tierWeights(1, overrides);
  let total = 0;
  for (const w of weights) total += w;
  return weights.map((w) => w / total);
}
