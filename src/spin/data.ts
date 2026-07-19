// Loads the generated /spin dataset (data/spin-data.json, built by
// scripts/build-spin-data.mjs) and exposes typed accessors. The dataset is
// immutable at runtime; balance lives in the build script + spec file.

import { readFileSync } from 'node:fs';

export interface SpinRarity {
  name: string;
  color: string;
  border: string;
}

export type ValueKind = 'flat' | 'card' | 'cash' | 'shinycash';
export type EffectKind = 'clover' | 'token' | 'stun' | 'radiance' | 'shade' | 'serum';

export interface SpinPetal {
  name: string;
  group: string;
  /** Value multiplier; negative petals subtract worth. */
  mult: number;
  /** Overrides |mult| for pool roll weight (Clover: luck 10x but value 1x). */
  weightMult: number | null;
  valueKind: ValueKind;
  /** PNG data URI. */
  image: string;
  /** Present on static specials: fixed chance, gated to tiers >= minTier. */
  static?: { chance: number; minTier: number };
  effect?: EffectKind;
}

interface SpinData {
  version: number;
  rarities: SpinRarity[];
  gates: { super: number; omega: number; fabled: number; eternal: number };
  petals: SpinPetal[];
}

const data = JSON.parse(
  readFileSync(new URL('../../data/spin-data.json', import.meta.url), 'utf8'),
) as SpinData;

export const rarities: readonly SpinRarity[] = data.rarities;
export const gates = data.gates;
export const petals: readonly SpinPetal[] = data.petals;
export const staticPetals: readonly SpinPetal[] = data.petals
  .filter((p) => p.static)
  .sort((a, b) => a.static!.chance - b.static!.chance); // rarest checked first
export const poolPetals: readonly SpinPetal[] = data.petals.filter((p) => !p.static);

export const MISSILE_FAMILY = new Set(['Missile', 'Homing Missile', 'Fire Missile']);

/** Base odds ratio between adjacent tiers. */
export const TIER_RATIO = 1.5;

// Tuned base value curve: compounding early game, linear mid game, compounding
// late game. Pieces join continuously at tiers 20 and 50.
const CURVE_MID_START = 5 * Math.pow(1.09, 20); // ≈ 28.02 at tier 20
const CURVE_END_START = CURVE_MID_START + 1.6 * 30; // ≈ 76.02 at tier 50

/** Base value of a rarity tier along the tuned curve: 5 at tier 0, ~28 at
 *  tier 20, ~76 at tier 50, ~135 at tier 68. Odds stay on the 1.5x ladder. */
export function rarityValue(tier: number): number {
  if (tier <= 20) return 5 * Math.pow(1.09, tier);
  if (tier <= 50) return CURVE_MID_START + 1.6 * (tier - 20);
  return CURVE_END_START + (1.5 * (Math.pow(1.085, tier - 50) - 1)) / 0.085;
}

/** Pool roll weight: 1 / |mult|, with Clover's luck value standing in for its mult. */
export function poolWeight(p: SpinPetal): number {
  return 1 / Math.abs(p.weightMult ?? p.mult);
}

/** Embed color int from a catalog hex color (#abc or #aabbcc). */
export function rarityColor(tier: number): number {
  let hex = rarities[tier]?.color ?? '#9b59b6';
  hex = hex.replace('#', '');
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
  const n = parseInt(hex, 16);
  return Number.isFinite(n) ? n : 0x9b59b6;
}

/** Petal name as shown to players. Blood Light is "Medium" from Eternal up. */
export function displayName(petal: SpinPetal, tier: number): string {
  if (petal.name === 'Blood Light' && tier >= gates.eternal) return 'Medium';
  return petal.name;
}

/** Case-insensitive petal lookup by name. */
const byName = new Map(data.petals.map((p) => [p.name.toLowerCase(), p]));
export function findPetal(name: string): SpinPetal | undefined {
  return byName.get(name.trim().toLowerCase());
}

/** Rarity tier index from a name or numeric string; -1 if unknown. */
export function findTier(input: string): number {
  const s = input.trim().toLowerCase();
  const asNum = Number(s);
  if (Number.isInteger(asNum) && asNum >= 0 && asNum < rarities.length) return asNum;
  return rarities.findIndex((r) => r.name.toLowerCase() === s);
}

const imageCache = new Map<string, Buffer>();

/** Decoded PNG for a petal (cached). */
export function petalImage(name: string): Buffer {
  let buf = imageCache.get(name);
  if (!buf) {
    const p = byName.get(name.toLowerCase());
    if (!p) throw new Error(`Unknown petal: ${name}`);
    buf = Buffer.from(p.image.replace(/^data:image\/png;base64,/, ''), 'base64');
    imageCache.set(name, buf);
  }
  return buf;
}
