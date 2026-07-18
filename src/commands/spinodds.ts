// /spinodds — the live odds table: rarity tiers, special petals, and rules.

import {
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { rarities, staticPetals } from '../spin/data.js';
import * as db from '../spin/db.js';
import { fmtChance, fmtDuration } from '../spin/format.js';
import { tierOdds } from '../spin/engine.js';

export const data = new SlashCommandBuilder()
  .setName('spinodds')
  .setDescription('Show the current /spin odds.');

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const odds = tierOdds(db.getWeightOverrides());
  const tierLines = odds.map((p, i) => `**${rarities[i].name}** — ${fmtChance(p)}`);

  const tiersEmbed = new EmbedBuilder()
    .setColor(0x9b59b6)
    .setTitle('🎰 Spin odds — rarity tiers')
    .setDescription(tierLines.join('\n'))
    .setFooter({ text: `Cooldown: ${fmtDuration(db.getCooldownMs())} • Luck boosts shift these odds upward` });

  const specialLines = staticPetals.map((p) => {
    const gate = p.static!.minTier > 0 ? ` (${rarities[p.static!.minTier].name}+ only)` : '';
    return `**${p.name}** — ${fmtChance(p.static!.chance)}${gate}`;
  });

  const specialsEmbed = new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle('✨ Special petals')
    .setDescription(
      specialLines.join('\n') +
        '\n\nEvery other petal rolls from the pool: the higher its value multiplier, ' +
        'the rarer it is (chance scales with 1 / multiplier). Blood petals have ' +
        'negative value — they subtract from your total.',
    );

  await interaction.reply({ embeds: [tiersEmbed, specialsEmbed], flags: MessageFlags.Ephemeral });
}
