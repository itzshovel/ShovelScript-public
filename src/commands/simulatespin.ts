// /simulatespin — roll a batch of spins at a chosen luck and show the outcome
// distribution. Records nothing (admin only). The `modifier` picks the roll
// model: "none" uses the live clamped-luck curve; "curve flatten multi" brings
// back the retired curve-flattening luck model for comparison.

import {
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { rarities, rarityColor } from '../spin/data.js';
import * as db from '../spin/db.js';
import * as engine from '../spin/engine.js';
import { fmtMult, fmtValue } from '../spin/format.js';

const MAX_COUNT = 100_000;

export const data = new SlashCommandBuilder()
  .setName('simulatespin')
  .setDescription('Simulate many spins at a chosen luck and show the outcome distribution (admin only).')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addIntegerOption((o) =>
    o
      .setName('count')
      .setDescription(`How many spins to simulate (1-${MAX_COUNT})`)
      .setRequired(true)
      .setMinValue(1)
      .setMaxValue(MAX_COUNT),
  )
  .addNumberOption((o) =>
    o.setName('luck').setDescription('Luck multiplier, e.g. 1, 5, 100').setRequired(true).setMinValue(1),
  )
  .addStringOption((o) =>
    o
      .setName('modifier')
      .setDescription('Roll model (default: none)')
      .addChoices(
        { name: 'None — current clamped luck', value: 'none' },
        { name: 'Curve flatten multiplier — old model', value: 'flatten' },
      ),
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.inGuild()) {
    await interaction.reply({ content: 'Run this in the server.', flags: MessageFlags.Ephemeral });
    return;
  }
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({
      content: 'You need the **Administrator** permission to run /simulatespin.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const count = Math.min(MAX_COUNT, Math.max(1, interaction.options.getInteger('count', true)));
  const luck = Math.max(1, interaction.options.getNumber('luck', true));
  const flatten = (interaction.options.getString('modifier') ?? 'none') === 'flatten';

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const sim = engine.simulateSpins(count, luck, db.getWeightOverrides(), flatten, Math.random);

  // Distribution of the tiers that actually came up.
  const distLines: string[] = [];
  for (let i = 0; i < rarities.length; i++) {
    const n = sim.tierCounts[i];
    if (n === 0) continue;
    const pct = (n / count) * 100;
    const pctStr = pct >= 0.1 ? `${pct.toFixed(1)}%` : `${pct.toExponential(1)}%`;
    distLines.push(`**${rarities[i].name}** — ${n} (${pctStr})`);
  }
  let dist = distLines.join('\n');
  if (dist.length > 3500) {
    // Keep it under the embed description cap — trim the deepest tiers.
    let kept = '';
    let shown = 0;
    for (const line of distLines) {
      if (kept.length + line.length + 1 > 3400) break;
      kept += (kept ? '\n' : '') + line;
      shown++;
    }
    dist = `${kept}\n…and ${distLines.length - shown} more tier${distLines.length - shown === 1 ? '' : 's'}`;
  }

  const best = sim.best
    ? `${rarities[sim.best.tier].name} ${sim.best.petal} — ${fmtValue(sim.best.value)}`
    : '—';
  const specials = sim.specialCounts.length
    ? sim.specialCounts.map((s) => `${s.name} ×${s.count}`).join(', ')
    : 'none';
  const highest =
    sim.highestTier >= 0
      ? `${rarities[sim.highestTier].name} (tier ${sim.highestTier + 1}/${rarities.length})`
      : '—';

  const embed = new EmbedBuilder()
    .setColor(rarityColor(Math.max(0, sim.highestTier)))
    .setTitle(`🎲 Simulated ${count.toLocaleString('en-US')} spins`)
    .setDescription(
      `Luck **x${fmtMult(luck)}** • Model: **${flatten ? 'curve flatten (old)' : 'clamped (current)'}**\n\n${dist}`,
    )
    .addFields(
      { name: 'Best pull', value: best },
      { name: 'Highest tier', value: highest, inline: true },
      { name: 'Total value', value: fmtValue(sim.totalValue), inline: true },
      { name: 'Avg / spin', value: fmtValue(sim.totalValue / count), inline: true },
      { name: 'Specials hit', value: specials },
    )
    .setFooter({ text: 'Simulation only — nothing recorded' });

  await interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
}
