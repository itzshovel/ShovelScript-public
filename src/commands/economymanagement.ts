// /economymanagement — owner-only option panel for the spin economy:
// - Recalculate: rewrites every player's total worth from the petals they
//   currently own, valued under the current curve (for after balance retunes).
//   Idempotent, so it only needs a confirm click.
// - Reset: the nuclear option — wipes every player's collection, worth,
//   effects, and the sacrifice queue. Keeps its three verification layers:
//   hardcoded owner id, an "are you sure" button, and a modal asking for the
//   reset secret (the usage worker's ADMIN_KEY value, mirrored into the
//   RESET_SECRET_KEY env var).
// The database is backed up before either operation.

import { createHash, timingSafeEqual } from 'node:crypto';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Message,
  type ModalSubmitInteraction,
} from 'discord.js';
import { config } from '../config.js';
import { findPetal } from '../spin/data.js';
import * as db from '../spin/db.js';
import * as engine from '../spin/engine.js';

export const data = new SlashCommandBuilder()
  .setName('economymanagement')
  .setDescription('Owner only: reset the spin economy or recalculate totals under the current values.')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

function secretMatches(input: string): boolean {
  if (!config.resetSecretKey) return false;
  // Hash both sides so timingSafeEqual gets equal-length buffers.
  const a = createHash('sha256').update(input.trim()).digest();
  const b = createHash('sha256').update(config.resetSecretKey).digest();
  return timingSafeEqual(a, b);
}

async function awaitOwnerButton(message: Message, time: number): Promise<ButtonInteraction | null> {
  try {
    return await message.awaitMessageComponent({
      componentType: ComponentType.Button,
      time,
      filter: (i) => i.user.id === config.ownerId,
    });
  } catch {
    return null;
  }
}

function yesCancelRow(sid: string, yesLabel: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`eco:go:${sid}`).setLabel(yesLabel).setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`eco:cancel:${sid}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
  );
}

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.inGuild()) {
    await interaction.reply({ content: 'Run this in the server.', flags: MessageFlags.Ephemeral });
    return;
  }
  if (interaction.user.id !== config.ownerId) {
    await interaction.reply({
      content: 'Only the bot owner can run /economymanagement.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const sid = interaction.id;
  const panel = new EmbedBuilder()
    .setColor(0x9b59b6)
    .setTitle('🛠️ Economy management')
    .setDescription(
      '**🔄 Recalculate totals** — rewrite every player\'s total worth from the petals ' +
        'they currently own, valued under the current value curve. Collections are untouched.\n\n' +
        '**🌪️ Reset economy** — wipe every player\'s collection, worth, effects, and the ' +
        'sacrifice queue. Requires the secret key.',
    )
    .setFooter({ text: 'A database backup is taken before either operation.' });
  const panelRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`eco:recalc:${sid}`).setLabel('🔄 Recalculate totals').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`eco:reset:${sid}`).setLabel('🌪️ Reset economy').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`eco:cancel:${sid}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
  );

  await interaction.reply({ embeds: [panel], components: [panelRow], flags: MessageFlags.Ephemeral });
  const message = await interaction.fetchReply();

  const choice = await awaitOwnerButton(message, 60_000);
  if (!choice) {
    await interaction.editReply({ components: [] }).catch(() => {});
    return;
  }
  if (choice.customId === `eco:cancel:${sid}`) {
    await choice.update({ content: 'Closed.', embeds: [], components: [] });
    return;
  }

  if (choice.customId === `eco:recalc:${sid}`) {
    const confirm = new EmbedBuilder()
      .setColor(0xf1c40f)
      .setTitle('🔄 Recalculate all totals?')
      .setDescription(
        'Every player\'s total worth is **rewritten** from their current collection under ' +
          'the current value curve. Old totals are overwritten; collections, effects, and ' +
          'the sacrifice queue are untouched.\n\nSafe to run again at any time.',
      );
    await choice.update({ embeds: [confirm], components: [yesCancelRow(sid, 'Yes, recalculate')] });

    const go = await awaitOwnerButton(message, 60_000);
    if (!go) {
      await interaction.editReply({ components: [] }).catch(() => {});
      return;
    }
    if (go.customId !== `eco:go:${sid}`) {
      await go.update({ content: 'Recalculation cancelled.', embeds: [], components: [] });
      return;
    }

    const backupPath = db.backupDatabase(Date.now());
    const updated = db.recalculateEconomy((petalName, tier, highestTier) => {
      const petal = findPetal(petalName);
      return petal ? engine.computeValue(petal, tier, Math.max(highestTier, tier), false) : 0;
    });

    await go.update({
      content: `✅ Recalculated ${updated} player total${updated === 1 ? '' : 's'}. Backup saved to \`${backupPath}\`.`,
      embeds: [],
      components: [],
    });

    const announce = new EmbedBuilder()
      .setColor(0xf1c40f)
      .setTitle('📊 Collection totals recalculated!')
      .setDescription('Every collection has been revalued under the current petal values. Check /spintop!')
      .setFooter({ text: 'Your petals are unchanged — only their worth was updated' });
    await go.followUp({ embeds: [announce], allowedMentions: { parse: [] } });
    return;
  }

  // --- reset path ----------------------------------------------------------
  if (!config.resetSecretKey) {
    await choice.update({
      content: 'Economy reset is disabled: the RESET_SECRET_KEY environment variable is not set.',
      embeds: [],
      components: [],
    });
    return;
  }

  const warn = new EmbedBuilder()
    .setColor(0xe74c3c)
    .setTitle('⚠️ Reset the entire spin economy?')
    .setDescription(
      'This wipes **every player\'s collection, total worth, effects, and the sacrifice queue**. ' +
        'Staff config (cooldown, flair, channel lock, odds) is kept.\n\n' +
        'A database backup is taken first, but treat this as **irreversible**.',
    );
  await choice.update({ embeds: [warn], components: [yesCancelRow(sid, 'Yes, continue')] });

  const go = await awaitOwnerButton(message, 60_000);
  if (!go) {
    await interaction.editReply({ components: [] }).catch(() => {});
    return;
  }
  if (go.customId !== `eco:go:${sid}`) {
    await go.update({ content: 'Reset cancelled.', embeds: [], components: [] });
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId(`eco:key:${sid}`)
    .setTitle('Verify: paste the secret key')
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('secret')
          .setLabel('Wrangler worker secret key (ADMIN_KEY)')
          .setStyle(TextInputStyle.Short)
          .setRequired(true),
      ),
    );
  await go.showModal(modal);

  let submit: ModalSubmitInteraction;
  try {
    submit = await go.awaitModalSubmit({
      time: 120_000,
      filter: (i) => i.customId === `eco:key:${sid}` && i.user.id === config.ownerId,
    });
  } catch {
    await interaction.editReply({ components: [] }).catch(() => {});
    return;
  }

  if (!secretMatches(submit.fields.getTextInputValue('secret'))) {
    await submit.reply({ content: '❌ Wrong key. Nothing was reset.', flags: MessageFlags.Ephemeral });
    await interaction.editReply({ components: [] }).catch(() => {});
    return;
  }

  const backupPath = db.backupDatabase(Date.now());
  const wiped = db.resetEconomy();

  await submit.reply({
    content: `✅ Economy reset: wiped ${wiped} player${wiped === 1 ? '' : 's'}. Backup saved to \`${backupPath}\`.`,
    flags: MessageFlags.Ephemeral,
  });
  await interaction.editReply({ components: [] }).catch(() => {});

  const announce = new EmbedBuilder()
    .setColor(0xe74c3c)
    .setTitle('🌪️ The spin economy has been reset!')
    .setDescription('All collections and totals start fresh from zero. The petals await — /spin!')
    .setFooter({ text: 'A new era begins' });
  await submit.followUp({ embeds: [announce], allowedMentions: { parse: [] } });
}
