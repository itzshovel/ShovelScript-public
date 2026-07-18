// Pure roll + reward logic for /spin. No Discord or DB imports; everything is
// parameterized (rng injectable) so it can be simulated and tested headlessly.
//
// Balance model (see tools/List of minigame petals.txt and CLAUDE-era spec):
// - Rarity tier: weight (1/1.5)^tier across the 69 usable tiers. Luck L softens
//   the ladder to ratio 1.5^(1/L) for that spin. Staff overrides multiply
//   individual tier weights.
// - Petal: static specials first (fixed chance, tier-gated, rarest checked
//   first), then a weighted pick over the pool at weight 1/|mult|.
// - Value: mult * 1.5^tier, except Card 5*R^2, Cash 7.5*R^2 and
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
 *  one-shot boosts (clover, token) multiply the total and are consumed. */
export function computeLuck(effects: EffectRow[], now: number): LuckResult {
  let additive = 1;
  let oneShot = 1;
  const consumedIds: number[] = [];
  const parts: string[] = [];

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

/** Roll a rarity tier. Weight_i = (1/r)^i with r = 1.5^(1/luck), times any
 *  staff override for that tier (0 disables a tier). */
export function rollTier(luck: number, overrides: Record<number, number>, rng: Rng): number {
  const r = Math.pow(TIER_RATIO, 1 / Math.max(luck, 0.01));
  const weights: number[] = [];
  let total = 0;
  for (let i = 0; i < rarities.length; i++) {
    const w = Math.pow(r, -i) * (overrides[i] ?? 1);
    weights.push(w);
    total += w;
  }
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

/** Current tier odds (no luck), for /spinodds: probability per tier. */
export function tierOdds(overrides: Record<number, number>): number[] {
  const weights: number[] = [];
  let total = 0;
  for (let i = 0; i < rarities.length; i++) {
    const w = Math.pow(TIER_RATIO, -i) * (overrides[i] ?? 1);
    weights.push(w);
    total += w;
  }
  return weights.map((w) => w / total);
}
