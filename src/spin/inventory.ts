// Shared collection rendering for /collection and /inventory: groups a user's
// stacks by rarity into description pages plus a summary line.

import { displayName, findPetal, rarities, rarityColor } from './data.js';
import type { CollectionRow, SpinUser } from './db.js';
import { chunkLines, fmtValue } from './format.js';

export interface InventoryView {
  summary: string;
  pages: string[];
  color: number;
  stacks: number;
}

export function buildInventoryView(user: SpinUser, rows: CollectionRow[]): InventoryView {
  const lines: string[] = [];
  let lastTier = -1;
  let stacks = 0;
  for (const row of rows) {
    if (row.tier !== lastTier) {
      lines.push(`**— ${rarities[row.tier]?.name ?? `Tier ${row.tier}`} —**`);
      lastTier = row.tier;
    }
    const petal = findPetal(row.petal);
    const name = petal ? displayName(petal, row.tier) : row.petal;
    lines.push(`${name} ×${row.count}`);
    stacks++;
  }

  const highest = user.highestTier >= 0 ? rarities[user.highestTier]?.name ?? '?' : 'none';
  return {
    summary:
      `**Total worth:** ${fmtValue(user.totalValue)} • **Spins:** ${user.spinCount} • ` +
      `**Best pull:** ${highest} • **Stacks:** ${stacks}`,
    pages: chunkLines(lines),
    color: user.highestTier >= 0 ? rarityColor(user.highestTier) : 0x9b59b6,
    stacks,
  };
}
