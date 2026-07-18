// Headless sanity harness for the /spin engine. Run from the bot folder:
//   node --import tsx scripts/simulate-spins.ts
// Exercises the roll model over many spins and asserts the balance invariants.
// No Discord, no DB (engine's db import is type-only).

import {
  gates,
  petalImage,
  petals,
  poolPetals,
  poolWeight,
  rarities,
  rarityValue,
} from '../src/spin/data.js';
import * as engine from '../src/spin/engine.js';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

const N = 200_000;
const rng = Math.random;

// --- dataset ---------------------------------------------------------------
check('69 rarity tiers', rarities.length === 69);
check('146 petals', petals.length === 146);
check('gates', gates.super === 7 && gates.omega === 8 && gates.fabled === 9 && gates.eternal === 19);

let badImages = 0;
for (const p of petals) {
  const buf = petalImage(p.name);
  if (buf.length < 50 || buf[0] !== 0x89 || buf[1] !== 0x50) badImages++;
}
check('all petal images decode as PNG', badImages === 0, `${badImages} bad`);

const air = poolPetals.find((p) => p.name === 'Air')!;
const rose = poolPetals.find((p) => p.name === 'Rose')!;
const pentagon = poolPetals.find((p) => p.name === 'Pentagon')!;
check('Air rolls 2x a normal petal', Math.abs(poolWeight(air) / poolWeight(rose) - 2) < 1e-9);
check('Pentagon rolls at 1/100 weight', Math.abs(poolWeight(pentagon) - 0.01) < 1e-9);

// --- tier distribution -----------------------------------------------------
const tierCounts = new Array(rarities.length).fill(0);
for (let i = 0; i < N; i++) tierCounts[engine.rollTier(1, {}, rng)]++;
const ratio01 = tierCounts[0] / tierCounts[1];
check('tier curve ~1.5x (tier0/tier1)', Math.abs(ratio01 - 1.5) < 0.1, ratio01.toFixed(3));

const odds = engine.tierOdds({});
const oddsSum = odds.reduce((a, b) => a + b, 0);
check('tierOdds sums to 1', Math.abs(oddsSum - 1) < 1e-9);
check('tierOdds tier0 ~1/3', Math.abs(odds[0] - 1 / 3) < 0.01, odds[0].toFixed(4));

let meanBase = 0;
for (let i = 0; i < rarities.length; i++) meanBase += i * odds[i];

const luckyCounts = new Array(rarities.length).fill(0);
for (let i = 0; i < N / 4; i++) luckyCounts[engine.rollTier(10, {}, rng)]++;
let meanLucky = 0;
for (let i = 0; i < rarities.length; i++) meanLucky += (i * luckyCounts[i]) / (N / 4);
check('10x luck raises mean tier a lot', meanLucky > meanBase + 8, `base ${meanBase.toFixed(2)} → lucky ${meanLucky.toFixed(2)}`);

const disabled = engine.tierOdds({ 0: 0 });
check('override 0 disables a tier', disabled[0] === 0);

// --- petal pick + specials -------------------------------------------------
const pickCounts = new Map<string, number>();
for (let i = 0; i < N; i++) {
  const tier = engine.rollTier(1, {}, rng);
  const p = engine.pickPetal(tier, rng);
  pickCounts.set(p.name, (pickCounts.get(p.name) ?? 0) + 1);
}
const eggs = pickCounts.get('Plastic Egg') ?? 0;
check('Plastic Egg near 0.5% static', eggs > N * 0.003 && eggs < N * 0.007, `${eggs}/${N}`);
const cards = pickCounts.get('Card') ?? 0;
const hexes = pickCounts.get('Hexagon') ?? 0;
console.log(`  info: rare statics over ${N} spins — Card ${cards}, Hexagon ${hexes} (gated, expected single digits)`);

// Gates respected: force high tier and confirm statics can fire; force tier 0 and confirm they can't.
let gateBreach = 0;
for (let i = 0; i < 50_000; i++) {
  const p = engine.pickPetal(0, rng);
  if (p.static && p.static.minTier > 0) gateBreach++;
}
check('tier gates respected at tier 0', gateBreach === 0);

// --- value math ------------------------------------------------------------
const R10 = rarityValue(10);
const bloodRose = petals.find((p) => p.name === 'Blood Rose')!;
check('Blood Rose value negative', engine.computeValue(bloodRose, 10, 10, false) === -2 * R10);
const card = petals.find((p) => p.name === 'Card')!;
check('Card value = 5*R^2', engine.computeValue(card, 10, 10, false) === 5 * R10 * R10);
const shinyCash = petals.find((p) => p.name === 'Shiny Cash')!;
check(
  'Shiny Cash uses highest-ever tier',
  engine.computeValue(shinyCash, 10, 20, false) === 2 * rarityValue(20) * R10 * R10,
);
const missile = petals.find((p) => p.name === 'Missile')!;
check('Serum triples missiles', engine.computeValue(missile, 5, 5, true) === 3 * rarityValue(5));

let nanCount = 0;
for (const p of petals) {
  for (const tier of [0, 8, 34, 68]) {
    const v = engine.computeValue(p, tier, 68, true);
    if (!Number.isFinite(v)) nanCount++;
  }
}
check('no NaN/Inf values across all petals x tiers', nanCount === 0);

// --- luck effects ----------------------------------------------------------
const now = 1_000_000_000_000;
const HOUR = 3_600_000;
const mkEffect = (id: number, kind: string, mult: number, startsMs: number, expiresMs: number) => ({
  id, kind, mult, startsMs, expiresMs,
});

const radHalf = engine.computeLuck([mkEffect(1, 'radiance', 1, now - 12 * HOUR, now + 12 * HOUR)], now);
check('Radiance halfway = 5.5x', Math.abs(radHalf.luck - 5.5) < 1e-9);

const stacked = engine.computeLuck(
  [
    mkEffect(1, 'egg_luck', 2, now - HOUR, now + HOUR), // +1
    mkEffect(2, 'shade', 1, now, now + 24 * HOUR), // 10x at start → +9
    mkEffect(3, 'clover', 10, now, -1), // ×10 one-shot
  ],
  now,
);
check('stacking: (1+1+9) x 10 = 110', Math.abs(stacked.luck - 110) < 1e-9, String(stacked.luck));
check('one-shots consumed', stacked.consumedIds.length === 1 && stacked.consumedIds[0] === 3);

const expired = engine.computeLuck([mkEffect(1, 'radiance', 1, now - 30 * HOUR, now - 6 * HOUR)], now);
check('expired effects ignored', expired.luck === 1);

const egg = engine.resolveEffect(petals.find((p) => p.name === 'Plastic Egg')!, now, rng);
check(
  'Plastic Egg: 6h stun then 18h 2x luck',
  egg.stunnedUntilMs === now + 6 * HOUR &&
    egg.newEffects[0].startsMs === now + 6 * HOUR &&
    egg.newEffects[0].expiresMs === now + 24 * HOUR,
);

const token = engine.resolveEffect(petals.find((p) => p.name === 'Token')!, now, rng);
check('Token one-shot 2-5x', token.newEffects[0].expiresMs === -1 && token.newEffects[0].mult >= 2 && token.newEffects[0].mult <= 5);

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
