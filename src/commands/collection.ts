// /collection — view a player's petal collection, grouped by rarity.

import {
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { displayName, findPetal, rarities, rarityColor } from '../spin/data.js';
import * as db from '../spin/db.js';
import { chunkLines, fmtValue } from '../spin/format.js';

export const data = new SlashCommandBuilder()
  .setName('collection')
  .setDescription('View a petal collection from /spin.')
  .addUserOption((o) => o.setName('user').setDescription('Whose collection (default: yours)'))
  .addIntegerOption((o) => o.setName('page').setDescription('Page number').setMinValue(1));

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.inGuild()) {
    await interaction.reply({ content: 'Run this in the server.', flags: MessageFlags.Ephemeral });
    return;
  }

  const target = interaction.options.getUser('user') ?? interaction.user;
  const user = db.getUser(target.id);
  const rows = db.getCollection(target.id);

  if (rows.length === 0) {
    await interaction.reply({
      content: `${target.id === interaction.user.id ? 'You have' : `${target.username} has`} no petals yet. Try /spin!`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const lines: string[] = [];
  let lastTier = -1;
  let uniqueStacks = 0;
  for (const row of rows) {
    if (row.tier !== lastTier) {
      lines.push(`**— ${rarities[row.tier]?.name ?? `Tier ${row.tier}`} —**`);
      lastTier = row.tier;
    }
    const petal = findPetal(row.petal);
    const name = petal ? displayName(petal, row.tier) : row.petal;
    lines.push(`${name} ×${row.count}`);
    uniqueStacks++;
  }

  const pages = chunkLines(lines);
  const page = Math.min(interaction.options.getInteger('page') ?? 1, pages.length);
  const highest = user.highestTier >= 0 ? rarities[user.highestTier]?.name ?? '?' : 'none';

  const embed = new EmbedBuilder()
    .setColor(user.highestTier >= 0 ? rarityColor(user.highestTier) : 0x9b59b6)
    .setTitle(`${target.username}'s collection`)
    .setDescription(
      `**Total worth:** ${fmtValue(user.totalValue)} • **Spins:** ${user.spinCount} • ` +
        `**Best pull:** ${highest} • **Stacks:** ${uniqueStacks}\n\n${pages[page - 1]}`,
    )
    .setFooter({ text: `Page ${page}/${pages.length}` });

  await interaction.reply({ embeds: [embed], allowedMentions: { parse: [] } });
}
