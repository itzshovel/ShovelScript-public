// /spintop — leaderboard of collection worth from /spin.

import {
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { rarities } from '../spin/data.js';
import * as db from '../spin/db.js';
import { fmtValue } from '../spin/format.js';

export const data = new SlashCommandBuilder()
  .setName('spintop')
  .setDescription('Leaderboard: who has the most valuable petal collection.');

const MEDALS = ['🥇', '🥈', '🥉'];

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.inGuild()) {
    await interaction.reply({ content: 'Run this in the server.', flags: MessageFlags.Ephemeral });
    return;
  }

  const top = db.getTop(10);
  if (top.length === 0) {
    await interaction.reply({ content: 'Nobody has spun yet. Be the first with /spin!', flags: MessageFlags.Ephemeral });
    return;
  }

  const lines = top.map((u, i) => {
    const rank = MEDALS[i] ?? `**${i + 1}.**`;
    const best = u.highestTier >= 0 ? rarities[u.highestTier]?.name ?? '?' : 'none';
    return `${rank} <@${u.userId}> — **${fmtValue(u.totalValue)}** • best: ${best} • ${u.spinCount} spins`;
  });

  const embed = new EmbedBuilder()
    .setColor(0x9b59b6)
    .setTitle('🏆 Spin leaderboard')
    .setDescription(lines.join('\n'))
    .setFooter({ text: 'Ranked by total collection worth' });

  await interaction.reply({ embeds: [embed], allowedMentions: { parse: [] } });
}
