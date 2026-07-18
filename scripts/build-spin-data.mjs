// Builds data/spin-data.json for the /spin minigame from the shared flowr catalog
// (../tools/flowr-catalog.json) and the balance spec (../tools/List of minigame petals.txt,
// transcribed below as structured data so typos fail loudly instead of silently).
//
// Run from the bot folder:  node scripts/build-spin-data.mjs
// Re-run whenever the catalog or the balance spec changes.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const here = dirname(fileURLToPath(import.meta.url));
const CATALOG_PATH = join(here, '..', '..', 'tools', 'flowr-catalog.json');
const OUT_PATH = join(here, '..', 'data', 'spin-data.json');

// ---------------------------------------------------------------------------
// Balance spec (from tools/List of minigame petals.txt).
// mult is the petal value multiplier; pool roll weight = 1 / |mult| unless the
// petal is a static special (fixed chance, rarity-gated, outside the pool).
// ---------------------------------------------------------------------------

const GROUPS = [
  { group: 'rare blood', mult: -5, petals: ['Blood Horn', 'Bloodshot Eye', 'Blood Jolt'] },
  {
    group: 'blood',
    mult: -2,
    petals: [
      'Blood Light', 'Blood Oranges', 'Blood Corn', 'Blood Mandible',
      'Blood Watermelon', 'Blood Rose', 'Blood Leaf',
    ],
  },
  { group: 'trash', mult: 0.5, petals: ['Air', 'Bubble'] },
  {
    group: 'rare',
    mult: 1.5,
    petals: [
      'Blade', 'Bloom', 'Waterlogged Dark Compass', 'Third Eye', 'Hornet Egg',
      'Cinderleaf', 'Homing Missile', 'Fire Missile', 'Dark Spine', 'Neutron Star',
      'Batrachotoxin', 'Neurotoxin', 'Trident',
    ],
  },
  { group: 'amulet', mult: 1.75, petals: ['Amulet of Divergence', 'Amulet of Grace', 'Amulet of Time'] },
  {
    group: 'shiny',
    mult: 2,
    petals: [
      'Shiny Lightning', 'Shiny Leaf', 'Shiny Bubble', 'Shiny Cactus',
      'Shiny Egg', 'Shiny Iris', 'Shiny Wing', 'Shiny Yucca',
    ],
  },
  // Spec: shiny ruby is a shiny gemstone, special-cased to 6x.
  { group: 'shiny gemstone', mult: 6, petals: ['Shiny Ruby'] },
  {
    group: 'trinket',
    mult: 2.5,
    petals: ['Bauble of the Honeycomb', 'Trinket of the Sea', 'Trinket of the Hivemind', 'Trinket of the Wild'],
  },
  { group: 'gemstone', mult: 3, petals: ['Ruby', 'Emerald', 'Sapphire'] },
  {
    group: 'relic',
    mult: 3.5,
    petals: [
      'Shattered Relic of Wrath', 'Reinforced Relic of Wrath',
      'Subset Relic of the Guardian', 'Division Relic of the Guardian',
      'Guard Relic of the Guardian', 'Knight Relic of the Guardian',
      'Aid Relic of Serenity', 'Subliminal Relic of Serenity', 'Barrier Relic of Serenity',
    ],
  },
  { group: 'shard', mult: 4, petals: ['Shard of Divergence', 'Shard of Grace', 'Shard of Time'] },
  { group: 'artifact', mult: 5, petals: ['Abyssal Artifact'] },
  { group: 'unobtainable', mult: 10, petals: ['Brisingida', 'Neuroflare Egg', 'Mini Flower'] },
  { group: 'special', mult: 12.5, petals: ['Square'] },
  { group: 'special', mult: 100, petals: ['Pentagon'] },
];

// Clover stays in the normal pool (weight from its 10x luck multiplier) but its
// reward is the luck boost; its collectible value is a normal 1x.
const CLOVER = { name: 'Clover', group: 'special', mult: 1, weightMult: 10, effect: 'clover' };

// Static specials: fixed chance per spin, only when the rolled tier is >= minTier
// (tier indices resolved from the catalog rarity names below). valueKind:
//   flat      -> value = mult * rarityValue
//   card      -> value = 5   * rarityValue^2
//   cash      -> value = 7.5 * rarityValue^2
//   shinycash -> value = 2 * rarityValue(highest tier ever) * rarityValue^2
const STATICS = [
  { name: 'Hexagon', chance: 0.0003, minTierName: 'Omega', mult: -666, valueKind: 'flat' },
  { name: 'Card', chance: 0.00075, minTierName: 'Fabled', mult: 1, valueKind: 'card' },
  { name: 'Cash', chance: 0.0003, minTierName: 'Super', mult: 1, valueKind: 'cash' },
  { name: 'Shiny Cash', chance: 0.00005, minTierName: 'Super', mult: 1, valueKind: 'shinycash' },
  { name: 'Plastic Egg', chance: 0.005, minTierName: null, mult: 1, valueKind: 'flat', effect: 'stun' },
  { name: 'Radiance', chance: 0.005, minTierName: null, mult: 1, valueKind: 'flat', effect: 'radiance' },
  { name: 'Shade', chance: 0.005, minTierName: null, mult: 1, valueKind: 'flat', effect: 'shade' },
  { name: 'Royal Serum', chance: 0.0025, minTierName: null, mult: 1, valueKind: 'flat', effect: 'serum' },
  { name: 'Token', chance: 0.001, minTierName: null, mult: 1, valueKind: 'flat', effect: 'token' },
];

// ---------------------------------------------------------------------------

const catalog = JSON.parse(readFileSync(CATALOG_PATH, 'utf8'));

const rarities = catalog.rarities
  .slice(0, catalog.usableRarityCount)
  .map((r) => ({ name: r.name, color: r.color, border: r.border }));

function tierIndex(name) {
  const i = rarities.findIndex((r) => r.name === name);
  if (i < 0) throw new Error(`Rarity gate "${name}" not found in catalog rarities`);
  return i;
}
const gates = {
  super: tierIndex('Super'),
  omega: tierIndex('Omega'),
  fabled: tierIndex('Fabled'),
  eternal: tierIndex('Eternal'),
};

// Case/spacing-insensitive lookup from spec name -> canonical catalog key.
const canon = new Map(catalog.petals.map((p) => [p.toLowerCase().replace(/\s+/g, ' ').trim(), p]));
function resolve(specName) {
  const key = canon.get(specName.toLowerCase().replace(/\s+/g, ' ').trim());
  if (!key) throw new Error(`Spec petal "${specName}" not found in catalog`);
  return key;
}

// Gold-tint the Cash icon for Shiny Cash (no dedicated art yet).
function goldTint(dataUri) {
  const b64 = dataUri.replace(/^data:image\/png;base64,/, '');
  const png = PNG.sync.read(Buffer.from(b64, 'base64'));
  const d = png.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    d[i] = Math.min(255, Math.round(d[i] * 1.1 + 45)); // r toward gold
    d[i + 1] = Math.min(255, Math.round(d[i + 1] * 0.92 + 25)); // g slightly warm
    d[i + 2] = Math.round(d[i + 2] * 0.3); // crush blue
  }
  return `data:image/png;base64,${PNG.sync.write(png).toString('base64')}`;
}

const petals = new Map(); // canonical name -> entry
for (const name of catalog.petals) {
  const image = catalog.images[name];
  if (!image) throw new Error(`Catalog petal "${name}" has no image`);
  petals.set(name, { name, group: 'normal', mult: 1, weightMult: null, valueKind: 'flat', image });
}

for (const g of GROUPS) {
  for (const specName of g.petals) {
    const entry = petals.get(resolve(specName));
    entry.group = g.group;
    entry.mult = g.mult;
  }
}

{
  const entry = petals.get(resolve(CLOVER.name));
  entry.group = CLOVER.group;
  entry.mult = CLOVER.mult;
  entry.weightMult = CLOVER.weightMult;
  entry.effect = CLOVER.effect;
}

for (const s of STATICS) {
  let entry;
  if (s.name === 'Shiny Cash') {
    // Not in the catalog: synthesize from Cash with a gold tint.
    entry = { name: 'Shiny Cash', image: goldTint(catalog.images[resolve('Cash')]) };
    petals.set('Shiny Cash', entry);
  } else {
    entry = petals.get(resolve(s.name));
  }
  entry.group = 'static';
  entry.mult = s.mult;
  entry.valueKind = s.valueKind;
  entry.static = { chance: s.chance, minTier: s.minTierName ? tierIndex(s.minTierName) : 0 };
  if (s.effect) entry.effect = s.effect;
}

const out = {
  version: 1,
  rarities,
  gates,
  petals: [...petals.values()],
};

mkdirSync(dirname(OUT_PATH), { recursive: true });
writeFileSync(OUT_PATH, JSON.stringify(out));

const poolCount = out.petals.filter((p) => !p.static).length;
console.log(
  `Wrote ${OUT_PATH}: ${out.petals.length} petals (${poolCount} in pool, ${out.petals.length - poolCount} statics), ` +
    `${rarities.length} tiers, gates ${JSON.stringify(gates)}`,
);
