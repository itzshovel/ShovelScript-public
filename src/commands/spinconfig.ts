// /spinconfig — staff menu for the /spin minigame: cooldown, big-pull flair
// tier, and per-tier odds weight overrides. Gated by the same staff role as
// /setup. All values persist in SQLite and apply immediately.

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  EmbedBuilder,
  GuildMemberRoleManager,
  MessageFlags,
  ModalBuilder,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type ModalSubmitInteraction,
} from 'discord.js';
import { config } from '../config.js';
import { findTier, rarities } from '../spin/data.js';
import * as db from '../spin/db.js';
import { fmtDuration, parseDuration } from '../spin/format.js';

export const data = new SlashCommandBuilder()
  .setName('spinconfig')
  .setDescription('Adjust /spin cooldown, flair tier, odds, channel lock, and chat prefix (staff only).');

// Same dual-shape role check as /setup (GuildMember vs raw API member).
function hasStaffRole(interaction: ChatInputCommandInteraction): boolean {
  const roles = interaction.member?.roles;
  if (!roles) return false;
  if (roles instanceof GuildMemberRoleManager) return roles.cache.has(config.setupRoleId);
  return Array.isArray(roles) ? roles.includes(config.setupRoleId) : false;
}

function configEmbed(): EmbedBuilder {
  const overrides = db.getWeightOverrides();
  const entries = Object.entries(overrides);
  const overrideText = entries.length
    ? entries
        .map(([tier, mult]) => `${rarities[Number(tier)]?.name ?? `Tier ${tier}`} ×${mult}`)
        .join(', ')
    : 'none (default 1.5x curve)';
  const flair = db.getFlairTier();
  const channelId = db.getSpinChannelId();
  return new EmbedBuilder()
    .setColor(0x9b59b6)
    .setTitle('⚙️ Spin config')
    .addFields(
      { name: 'Cooldown', value: fmtDuration(db.getCooldownMs()), inline: true },
      { name: 'Flair from', value: `${rarities[flair]?.name ?? '?'} (tier ${flair})`, inline: true },
      { name: 'Spin channel', value: channelId ? `<#${channelId}>` : 'anywhere', inline: true },
      { name: 'Chat prefix', value: `\`${db.getPrefix()}\``, inline: true },
      { name: 'Odds overrides', value: overrideText },
    )
    .setFooter({ text: 'Buttons below edit values. Menu expires after 5 minutes.' });
}

function textModal(
  id: string,
  title: string,
  inputs: Array<{ id: string; label: string; placeholder: string }>,
): ModalBuilder {
  const modal = new ModalBuilder().setCustomId(id).setTitle(title);
  for (const input of inputs) {
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(input.id)
          .setLabel(input.label)
          .setPlaceholder(input.placeholder)
          .setStyle(TextInputStyle.Short)
          .setRequired(true),
      ),
    );
  }
  return modal;
}

async function handleModal(
  btn: ButtonInteraction,
  modal: ModalBuilder,
  apply: (submit: ModalSubmitInteraction) => string, // returns confirmation or throws Error with user message
): Promise<void> {
  await btn.showModal(modal);
  let submit: ModalSubmitInteraction;
  try {
    submit = await btn.awaitModalSubmit({
      time: 120_000,
      filter: (i) => i.customId === modal.data.custom_id && i.user.id === btn.user.id,
    });
  } catch {
    return; // modal dismissed / timed out
  }
  try {
    const msg = apply(submit);
    await submit.reply({ content: msg, flags: MessageFlags.Ephemeral });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Invalid input.';
    await submit.reply({ content: `❌ ${msg}`, flags: MessageFlags.Ephemeral });
  }
}

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.inGuild()) {
    await interaction.reply({ content: 'Run this in the server.', flags: MessageFlags.Ephemeral });
    return;
  }
  if (!hasStaffRole(interaction)) {
    await interaction.reply({
      content: `You need the <@&${config.setupRoleId}> role to run /spinconfig.`,
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
    return;
  }

  const sid = interaction.id;
  const buttonRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`spincfg:cd:${sid}`).setLabel('Cooldown').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`spincfg:flair:${sid}`).setLabel('Flair tier').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`spincfg:weight:${sid}`).setLabel('Tier weight').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`spincfg:reset:${sid}`).setLabel('Reset weights').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`spincfg:unlock:${sid}`).setLabel('Unlock channel').setStyle(ButtonStyle.Secondary),
  );
  const prefixRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`spincfg:prefix:${sid}`).setLabel('Chat prefix').setStyle(ButtonStyle.Primary),
  );
  const channelRow = new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
    new ChannelSelectMenuBuilder()
      .setCustomId(`spincfg:chan:${sid}`)
      .setPlaceholder('Lock /spin to a channel…')
      .setChannelTypes(ChannelType.GuildText),
  );

  await interaction.reply({
    embeds: [configEmbed()],
    components: [buttonRow, prefixRow, channelRow],
    flags: MessageFlags.Ephemeral,
  });
  const message = await interaction.fetchReply();

  const collector = message.createMessageComponentCollector({
    time: 300_000,
    filter: (i) => i.user.id === interaction.user.id,
  });

  collector.on('collect', (component) => {
    void (async () => {
      if (component.isChannelSelectMenu()) {
        db.setSpinChannelId(component.values[0]);
        await component.update({ embeds: [configEmbed()] });
        return;
      }
      if (!component.isButton()) return;
      const btn: ButtonInteraction = component;
      const action = btn.customId.split(':')[1];

      if (action === 'unlock') {
        db.setSpinChannelId(null);
        await btn.update({ embeds: [configEmbed()] });
        return;
      }
      if (action === 'reset') {
        db.resetWeightOverrides();
        await btn.update({ embeds: [configEmbed()] });
        return;
      }

      if (action === 'cd') {
        await handleModal(
          btn,
          textModal(`spincfg:cdm:${sid}`, 'Spin cooldown', [
            { id: 'value', label: 'Cooldown (e.g. 180, 3m, 1h30m)', placeholder: '3m' },
          ]),
          (submit) => {
            const ms = parseDuration(submit.fields.getTextInputValue('value'));
            if (ms === null || ms < 0 || ms > 7 * 86_400_000) {
              throw new Error('Could not parse that duration (try "90s", "3m", "1h").');
            }
            db.setCooldownMs(ms);
            return `✅ Cooldown set to ${fmtDuration(ms)}.`;
          },
        );
      } else if (action === 'flair') {
        await handleModal(
          btn,
          textModal(`spincfg:flairm:${sid}`, 'Big-pull flair tier', [
            { id: 'value', label: 'Rarity name or tier index', placeholder: 'Omega' },
          ]),
          (submit) => {
            const tier = findTier(submit.fields.getTextInputValue('value'));
            if (tier < 0) throw new Error('Unknown rarity. Use a name like "Omega" or an index 0-68.');
            db.setFlairTier(tier);
            return `✅ Big-pull flair now starts at ${rarities[tier].name}.`;
          },
        );
      } else if (action === 'weight') {
        await handleModal(
          btn,
          textModal(`spincfg:weightm:${sid}`, 'Tier odds override', [
            { id: 'tier', label: 'Rarity name or tier index', placeholder: 'Nullborne' },
            { id: 'mult', label: 'Weight multiplier (1 = default, 0 = off)', placeholder: '1' },
          ]),
          (submit) => {
            const tier = findTier(submit.fields.getTextInputValue('tier'));
            if (tier < 0) throw new Error('Unknown rarity. Use a name like "Omega" or an index 0-68.');
            const mult = Number(submit.fields.getTextInputValue('mult'));
            if (!Number.isFinite(mult) || mult < 0) throw new Error('Multiplier must be a number ≥ 0.');
            db.setWeightOverride(tier, mult);
            return `✅ ${rarities[tier].name} weight ×${mult}${mult === 1 ? ' (back to default)' : ''}.`;
          },
        );
      } else if (action === 'prefix') {
        await handleModal(
          btn,
          textModal(`spincfg:prefixm:${sid}`, 'Chat command prefix', [
            { id: 'value', label: 'Prefix (1-5 characters, no spaces)', placeholder: '!' },
          ]),
          (submit) => {
            const p = submit.fields.getTextInputValue('value').trim();
            if (!p || p.length > 5 || /\s/.test(p)) {
              throw new Error('Prefix must be 1-5 characters with no spaces.');
            }
            db.setPrefix(p);
            return `✅ Chat commands now start with \`${p}\` (e.g. \`${p}spin\`).`;
          },
        );
      }

      await interaction.editReply({ embeds: [configEmbed()] }).catch(() => {});
    })().catch((err) => console.error('spinconfig component error:', err));
  });

  collector.on('end', () => {
    void interaction.editReply({ components: [] }).catch(() => {});
  });
}
