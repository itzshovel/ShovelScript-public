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
 *  5x). Staff overrides multiply on top (0 disables a tier).
 *
 *  `flatten` restores the ORIGINAL (retired) luck model: the same softening
 *  boost without the clamp, so luck bends the whole curve and deep tiers become
 *  astronomically more likely. Kept only for /simulatespin comparisons. */
export function tierWeights(luck: number, overrides: Record<number, number> = {}, flatten = false): number[] {
  const L = Math.max(luck, 1);
  const soften = 1 - 1 / L;
  const weights: number[] = [];
  for (let i = 0; i < rarities.length; i++) {
    const raw = Math.pow(TIER_RATIO, i * soften);
    const boost = flatten ? raw : Math.min(raw, L);
    weights.push(Math.pow(TIER_RATIO, -i) * boost * (overrides[i] ?? 1));
  }
  return weights;
}

/** Roll a rarity tier from the luck weights (clamped, or flattened if asked). */
export function rollTier(luck: number, overrides: Record<number, number>, rng: Rng, flatten = false): number {
  return sampleTier(tierWeights(luck, overrides, flatten), rng);
}

/** Weighted index pick over precomputed tier weights. */
function sampleTier(weights: number[], rng: Rng): number {
  let total = 0;
  for (const w of weights) total += w;
  let roll = rng() * total;
  for (let i = 0; i < weights.length; i++) {
    roll -= weights[i];
    if (roll < 0) return i;
  }
  return weights.length - 1;
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
  return effectByKind(petal.effect ?? '', now, rng);
}

/** The same effect outcomes keyed directly by kind, so admin tools can grant an
 *  effect without a petal. Unknown kinds are a no-op. */
export function effectByKind(kind: string, now: number, rng: Rng): EffectOutcome {
  switch (kind) {
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

/** Luck multiplier a sacrifice grants, per solved floor tier. Bigger sacrifices
 *  reach a higher floor and so get a bigger multiplier (small sacrifices ~x2,
 *  the deepest ~x100). The multiplier is folded into the spin's luck, but the
 *  floor is still applied as a minimum — so it only ever changes a spin whose
 *  boosted roll clears the floor. Tune this to trade base reliability against
 *  jackpot upside. */
export const SACRIFICE_MULT_PER_TIER = 1.7;

/** Multiplier "cost" to lift the floor from tier `t` to `t+1`. The floor climbs
 *  quickly through low rarities but far slower through high ones, so a big
 *  multiplier can't run the guaranteed floor away at the top of the ladder. */
function floorStepCost(tier: number): number {
  if (tier >= 50) return 450;
  if (tier >= 35) return 150;
  if (tier >= 20) return 85;
  return 50;
}

/** Tiers a multiplier lifts the floor above `baseTier`, spending it through the
 *  per-tier costs (each tier crossed divides the remaining budget). */
function floorBump(baseTier: number, mult: number): number {
  let budget = mult;
  let tier = baseTier;
  let bump = 0;
  while (tier < rarities.length - 1) {
    const cost = floorStepCost(tier);
    if (budget < cost) break;
    budget /= cost;
    tier++;
    bump++;
  }
  return bump;
}

/** Signed mean multiplier of a pool pull (negatives and fractionals included).
 *  Boost floors are chosen against this so a floored spin's realized value
 *  averages the per-spin redistribution target. */
const POOL_MEAN_MULT = (() => {
  let w = 0;
  let signed = 0;
  for (const p of poolPetals) {
    const pw = poolWeight(p);
    w += pw;
    signed += pw * p.mult;
  }
  return signed / w;
})();

/** Expected POOL pull value of one spin at luck L under the clamped model.
 *  Static specials are deliberately excluded (their squared/cubed values ride
 *  on tiny fixed chances a boost window almost never sees). Kept as a baseline
 *  reference and for the simulation harness. */
export function expectedValuePerSpin(luck: number): number {
  const weights = tierWeights(luck);
  let totalW = 0;
  for (const w of weights) totalW += w;
  let ev = 0;
  for (let i = 0; i < rarities.length; i++) {
    ev += (weights[i] / totalW) * POOL_MEAN_MULT * rarityValue(i);
  }
  return ev;
}

export interface SacrificeFloor {
  /** Guaranteed minimum rarity tier a boosted spin lands on. */
  floorTier: number;
  /** Chance (0..1) a boosted spin is floored one tier higher instead — smooths
   *  the coarse value jumps between adjacent tiers so the mean lands on target. */
  floorUpgrade: number;
}

/** Floor that pays out `targetPerSpin` on an average boosted spin. The
 *  mult-adjusted target is bracketed between two adjacent tiers and upgraded
 *  probabilistically, so the realized mean hits target despite coarse tier
 *  steps. */
export function sacrificeFloor(targetPerSpin: number): SacrificeFloor {
  const adj = targetPerSpin / POOL_MEAN_MULT;
  if (adj <= rarityValue(0)) return { floorTier: 0, floorUpgrade: 0 };
  let f = 0;
  for (let i = 0; i < rarities.length; i++) {
    if (rarityValue(i) <= adj) f = i;
    else break;
  }
  if (f >= rarities.length - 1) return { floorTier: f, floorUpgrade: 0 };
  const lo = rarityValue(f);
  const hi = rarityValue(f + 1);
  const floorUpgrade = Math.min(1, Math.max(0, (adj - lo) / (hi - lo)));
  return { floorTier: f, floorUpgrade };
}

/** Boost bought by sacrificing |value|. Two mechanics combine:
 *  - a FLOOR that redistributes SACRIFICE_REDIST of the value back reliably per
 *    spin (a typical window pays back ~80%, not the near-zero the old pure
 *    luck-multiplier model gave), and
 *  - a luck MULTIPLIER scaling with the sacrifice size, folded into each boosted
 *    spin's roll. Because the floor is applied as a minimum on top, the
 *    multiplier only changes a spin whose boosted roll would already clear the
 *    floor — the reliable base stays intact and the multiplier is upside.
 *  The multiplier also nudges the floor up (floorBump), but that climb slows
 *  sharply at high rarities so it can't run away at the top of the ladder. */
export function sacrificeBoost(absValue: number): SacrificeFloor & { spins: number; mult: number } {
  const spins = Math.min(25, Math.max(3, 3 + 2 * Math.floor(Math.log10(1 + absValue))));
  const targetPerSpin = (SACRIFICE_REDIST * absValue) / spins;
  const base = sacrificeFloor(targetPerSpin);
  const mult = 1 + SACRIFICE_MULT_PER_TIER * base.floorTier;
  const floorTier = Math.min(rarities.length - 1, base.floorTier + floorBump(base.floorTier, mult));
  return { floorTier, floorUpgrade: base.floorUpgrade, spins, mult };
}

/** Concrete floor tier for one boosted spin, sampling the fractional upgrade. */
export function rollFloorTier(floor: SacrificeFloor, rng: Rng): number {
  const tier = floor.floorTier + (rng() < floor.floorUpgrade ? 1 : 0);
  return Math.min(rarities.length - 1, tier);
}

/** Current tier odds (no luck), for /spinodds: probability per tier. */
export function tierOdds(overrides: Record<number, number>): number[] {
  const weights = tierWeights(1, overrides);
  let total = 0;
  for (const w of weights) total += w;
  return weights.map((w) => w / total);
}

// --- simulation (for /simulatespin) ----------------------------------------

export interface SpinSimSummary {
  count: number;
  luck: number;
  flatten: boolean;
  /** Spins that landed on each tier index. */
  tierCounts: number[];
  /** How often each static special (Card, Hexagon, Plastic Egg, …) came up. */
  specialCounts: Array<{ name: string; count: number }>;
  totalValue: number;
  best: { tier: number; petal: string; value: number } | null;
  highestTier: number;
}

/** Run `count` full spins (tier roll + petal pick + value) at a fixed luck and
 *  return an aggregate summary — no DB, no effects, nothing recorded. Weights
 *  are computed once and reused, so large counts stay cheap. */
export function simulateSpins(
  count: number,
  luck: number,
  overrides: Record<number, number>,
  flatten: boolean,
  rng: Rng,
): SpinSimSummary {
  const weights = tierWeights(luck, overrides, flatten);
  const tierCounts = new Array<number>(rarities.length).fill(0);
  const specials = new Map<string, number>();
  let totalValue = 0;
  let highestTier = -1;
  let best: { tier: number; petal: string; value: number } | null = null;

  for (let s = 0; s < count; s++) {
    const tier = sampleTier(weights, rng);
    const petal = pickPetal(tier, rng);
    if (tier > highestTier) highestTier = tier;
    const value = computeValue(petal, tier, highestTier, false);
    tierCounts[tier]++;
    totalValue += value;
    if (petal.static) specials.set(petal.name, (specials.get(petal.name) ?? 0) + 1);
    if (!best || value > best.value) best = { tier, petal: petal.name, value };
  }

  const specialCounts = [...specials.entries()]
    .map(([name, c]) => ({ name, count: c }))
    .sort((a, b) => b.count - a.count);

  return { count, luck, flatten, tierCounts, specialCounts, totalValue, best, highestTier };
}
