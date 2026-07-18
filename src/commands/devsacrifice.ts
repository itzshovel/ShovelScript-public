// /devsacrifice — dev/admin tool: apply a sacrifice-style server luck boost
// with a chosen multiplier and duration, burning nothing. Queues like a real
// sacrifice. `clear` wipes the existing boost queue first (the only way to
// remove a misconfigured boost); `silent` skips the public announcement.

import {
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import * as db from '../spin/db.js';

export const data = new SlashCommandBuilder()
  .setName('devsacrifice')
  .setDescription('Dev: apply a sacrifice luck boost without burning a petal (admin only).')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addNumberOption((o) =>
    o.setName('multiplier').setDescription('Luck multiplier, e.g. 2.5').setRequired(true).setMinValue(1).setMaxValue(1000),
  )
  .addIntegerOption((o) =>
    o.setName('duration').setDescription('How many server-wide spins it lasts').setRequired(true).setMinValue(1).setMaxValue(10000),
  )
  .addBooleanOption((o) =>
    o.setName('clear').setDescription('Wipe all active/queued sacrifice boosts first (default: no)'),
  )
  .addBooleanOption((o) =>
    o.setName('silent').setDescription('Skip the public announcement (default: no)'),
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.inGuild()) {
    await interaction.reply({ content: 'Run this in the server.', flags: MessageFlags.Ephemeral });
    return;
  }
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({
      content: 'You need the **Administrator** permission to run /devsacrifice.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const mult = interaction.options.getNumber('multiplier', true);
  const spins = interaction.options.getInteger('duration', true);
  const clear = interaction.options.getBoolean('clear') ?? false;
  const silent = interaction.options.getBoolean('silent') ?? false;

  let cleared = 0;
  if (clear) cleared = db.clearSacrificeQueue();

  db.enqueueDevBoost(interaction.user.id, mult, spins, Date.now());
  const queue = db.getSacrificeQueue();
  const isActive = queue.length === 1;

  await interaction.reply({
    content:
      `⚗️ Dev boost queued: **x${mult} luck for ${spins} spins**` +
      (clear ? ` (cleared ${cleared} existing boost${cleared === 1 ? '' : 's'} first)` : '') +
      (isActive ? ' — live now.' : ` — position ${queue.length} in the queue.`),
    flags: MessageFlags.Ephemeral,
  });

  if (!silent) {
    const announce = new EmbedBuilder()
      .setColor(0xf1c40f)
      .setTitle('⚗️ The spirits are generous!')
      .setDescription(
        `A **x${mult} luck boost for ${spins} spins** has been granted to the server.\n` +
          (isActive ? 'It is **live now** — go spin!' : 'It activates after the current boosts run out.'),
      )
      .setFooter({ text: 'Applies to everyone\'s spins' });
    await interaction.followUp({ embeds: [announce], allowedMentions: { parse: [] } });
  }
}
