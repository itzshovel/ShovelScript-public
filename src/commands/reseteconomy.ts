// /reseteconomy — owner-only nuclear option: wipes every player's collection,
// worth, effects, and the sacrifice queue, then the spin system starts fresh.
// Three layers: hardcoded owner id, an "are you sure" button, and a modal
// asking for the reset secret (the usage worker's ADMIN_KEY value, mirrored
// into the RESET_SECRET_KEY env var). The database is backed up first.

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
  type ChatInputCommandInteraction,
  type ModalSubmitInteraction,
} from 'discord.js';
import { config } from '../config.js';
import * as db from '../spin/db.js';

export const data = new SlashCommandBuilder()
  .setName('reseteconomy')
  .setDescription('Owner only: wipe all collections and restart the spin economy from zero.')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

function secretMatches(input: string): boolean {
  if (!config.resetSecretKey) return false;
  // Hash both sides so timingSafeEqual gets equal-length buffers.
  const a = createHash('sha256').update(input.trim()).digest();
  const b = createHash('sha256').update(config.resetSecretKey).digest();
  return timingSafeEqual(a, b);
}

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.inGuild()) {
    await interaction.reply({ content: 'Run this in the server.', flags: MessageFlags.Ephemeral });
    return;
  }
  if (interaction.user.id !== config.ownerId) {
    await interaction.reply({ content: 'Only the bot owner can run /reseteconomy.', flags: MessageFlags.Ephemeral });
    return;
  }
  if (!config.resetSecretKey) {
    await interaction.reply({
      content: '/reseteconomy is disabled: the RESET_SECRET_KEY environment variable is not set.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const sid = interaction.id;
  const warn = new EmbedBuilder()
    .setColor(0xe74c3c)
    .setTitle('⚠️ Reset the entire spin economy?')
    .setDescription(
      'This wipes **every player\'s collection, total worth, effects, and the sacrifice queue**. ' +
        'Staff config (cooldown, flair, channel lock, odds) is kept.\n\n' +
        'A database backup is taken first, but treat this as **irreversible**.',
    );
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`reset:go:${sid}`).setLabel('Yes, continue').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`reset:cancel:${sid}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
  );

  await interaction.reply({ embeds: [warn], components: [row], flags: MessageFlags.Ephemeral });
  const message = await interaction.fetchReply();

  let btn;
  try {
    btn = await message.awaitMessageComponent({
      componentType: ComponentType.Button,
      time: 60_000,
      filter: (i) => i.user.id === config.ownerId,
    });
  } catch {
    await interaction.editReply({ components: [] }).catch(() => {});
    return;
  }

  if (btn.customId !== `reset:go:${sid}`) {
    await btn.update({ content: 'Reset cancelled.', embeds: [], components: [] });
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId(`reset:key:${sid}`)
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
  await btn.showModal(modal);

  let submit: ModalSubmitInteraction;
  try {
    submit = await btn.awaitModalSubmit({
      time: 120_000,
      filter: (i) => i.customId === `reset:key:${sid}` && i.user.id === config.ownerId,
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
