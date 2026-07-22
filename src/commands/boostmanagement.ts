// /boostmanagement — admin panel to hand out or clear player effects and server
// sacrifice boosts (this replaces /devsacrifice). Pick a target player with the
// menu, then:
//   • Grant effect  — give that player a petal effect (clover, luck token,
//     radiance, shade, royal serum, or a Plastic Egg stun), exactly as pulling
//     that petal would.
//   • Clear effects — remove all of that player's effects and lift any stun.
// Server-wide (no target needed):
//   • Add luck boost  — a luck-only boost for N spins (the old /devsacrifice).
//   • Add floor boost — a free sacrifice-style boost from a chosen value, with
//     its floor and value-scaled multiplier.
//   • Clear boosts    — wipe the active and queued sacrifice boosts.
// Everything applies immediately. Admin only.

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type ModalSubmitInteraction,
} from 'discord.js';
import { rarities } from '../spin/data.js';
import * as db from '../spin/db.js';
import * as engine from '../spin/engine.js';
import { fmtMult, fmtValue } from '../spin/format.js';

export const data = new SlashCommandBuilder()
  .setName('boostmanagement')
  .setDescription('Admin: grant or clear player effects and server boosts.')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

// Effects an admin can hand out, keyed by the engine effect kind.
const EFFECT_CHOICES = ['clover', 'token', 'radiance', 'shade', 'serum', 'stun'] as const;
const EFFECT_LABELS: Record<string, string> = {
  clover: '🍀 Clover — 10x luck next spin',
  token: '🪙 Luck token — 2x-5x next spin',
  radiance: '✨ Radiance — 1x to 10x over 24h',
  shade: '🌑 Shade — 10x now, fading over 24h',
  serum: '🧪 Royal serum — 3x missiles for 24h',
  stun: '🥚 Plastic egg — stun then 2x luck',
};

function panelEmbed(targetId: string | null, nowMs: number): EmbedBuilder {
  const queue = db.getSacrificeQueue();
  const active = queue[0];
  const activeLine = active
    ? active.floorTier >= 0
      ? `🩸 Sacrifice floor ${rarities[active.floorTier].name}+ (x${fmtMult(active.mult)} luck), ${active.spinsLeft} spins left`
      : `⚗️ Luck boost x${fmtMult(active.mult)}, ${active.spinsLeft} spins left`
    : 'none active';
  const queuedLine = queue.length > 1 ? ` • ${queue.length - 1} queued` : '';

  let targetLine = '_Pick a player for the effect actions._';
  if (targetId) {
    const effects = db.getEffects(targetId);
    const stunned = db.isStunned(targetId, nowMs);
    const bits = effects.map((e) => e.kind);
    if (stunned) bits.push('stunned');
    targetLine = `<@${targetId}> — ${bits.length ? bits.join(', ') : 'no active effects'}`;
  }

  return new EmbedBuilder()
    .setColor(0x9b59b6)
    .setTitle('🎛️ Boost management')
    .addFields(
      { name: 'Target player', value: targetLine },
      { name: 'Server boosts', value: `${activeLine}${queuedLine}` },
    )
    .setFooter({ text: 'Effects need a target. Server boosts apply to everyone. Menu expires after 5 minutes.' });
}

function textModal(
  id: string,
  title: string,
  inputs: Array<{ id: string; label: string; placeholder: string; required?: boolean }>,
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
          .setRequired(input.required ?? true),
      ),
    );
  }
  return modal;
}

/** Shows a modal, waits for it, applies it, and returns a confirmation string.
 *  The apply callback throws Error(userMessage) to report a validation failure. */
async function handleModal(
  btn: ButtonInteraction,
  modal: ModalBuilder,
  apply: (submit: ModalSubmitInteraction) => string,
): Promise<void> {
  await btn.showModal(modal);
  let submit: ModalSubmitInteraction;
  try {
    submit = await btn.awaitModalSubmit({
      time: 120_000,
      filter: (i) => i.customId === modal.data.custom_id && i.user.id === btn.user.id,
    });
  } catch {
    return; // dismissed or timed out
  }
  try {
    await submit.reply({ content: apply(submit), flags: MessageFlags.Ephemeral });
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
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({
      content: 'You need the **Administrator** permission to run /boostmanagement.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const sid = interaction.id;
  let targetId: string | null = null;

  const userRow = new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(
    new UserSelectMenuBuilder().setCustomId(`boost:user:${sid}`).setPlaceholder('Pick a player for effect actions…'),
  );
  const effectRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`boost:grant:${sid}`).setLabel('Grant effect').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`boost:cleareff:${sid}`).setLabel('Clear effects').setStyle(ButtonStyle.Secondary),
  );
  const sacRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`boost:luck:${sid}`).setLabel('Add luck boost').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`boost:floor:${sid}`).setLabel('Add floor boost').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`boost:clearsacs:${sid}`).setLabel('Clear boosts').setStyle(ButtonStyle.Danger),
  );

  await interaction.reply({
    embeds: [panelEmbed(null, Date.now())],
    components: [userRow, effectRow, sacRow],
    flags: MessageFlags.Ephemeral,
  });
  const message = await interaction.fetchReply();

  const refresh = () =>
    interaction.editReply({ embeds: [panelEmbed(targetId, Date.now())] }).catch(() => {});

  const collector = message.createMessageComponentCollector({
    time: 300_000,
    filter: (i) => i.user.id === interaction.user.id,
  });

  collector.on('collect', (component) => {
    void (async () => {
      if (component.isUserSelectMenu()) {
        targetId = component.values[0];
        await component.update({ embeds: [panelEmbed(targetId, Date.now())] });
        return;
      }
      if (!component.isButton()) return;
      const btn: ButtonInteraction = component;
      const action = btn.customId.split(':')[1];
      const now = Date.now();

      if (action === 'grant') {
        if (!targetId) {
          await btn.reply({ content: 'Pick a player first.', flags: MessageFlags.Ephemeral });
          return;
        }
        const target = targetId;
        await handleModal(
          btn,
          textModal(`boost:grantm:${sid}`, 'Grant an effect', [
            { id: 'effect', label: 'Effect', placeholder: EFFECT_CHOICES.join(' / ') },
            { id: 'amount', label: 'Luck multiplier (clover/token only, optional)', placeholder: '10', required: false },
          ]),
          (submit) => {
            const kind = submit.fields.getTextInputValue('effect').trim().toLowerCase();
            if (!EFFECT_CHOICES.includes(kind as (typeof EFFECT_CHOICES)[number])) {
              throw new Error(`Unknown effect. Choose one of: ${EFFECT_CHOICES.join(', ')}.`);
            }
            const outcome = engine.effectByKind(kind, now, Math.random);
            const raw = submit.fields.getTextInputValue('amount').trim();
            if (raw && (kind === 'clover' || kind === 'token')) {
              const amount = Number(raw);
              if (!Number.isFinite(amount) || amount < 1) throw new Error('Multiplier must be a number ≥ 1.');
              if (outcome.newEffects[0]) outcome.newEffects[0].mult = amount;
            }
            db.grantEffect(target, outcome);
            return `✅ Gave <@${target}> ${EFFECT_LABELS[kind]}.`;
          },
        );
        await refresh();
        return;
      }

      if (action === 'cleareff') {
        if (!targetId) {
          await btn.reply({ content: 'Pick a player first.', flags: MessageFlags.Ephemeral });
          return;
        }
        const cleared = db.clearEffects(targetId);
        await btn.reply({
          content: `✅ Cleared ${cleared} effect${cleared === 1 ? '' : 's'} from <@${targetId}> and lifted any stun.`,
          flags: MessageFlags.Ephemeral,
          allowedMentions: { parse: [] },
        });
        await refresh();
        return;
      }

      if (action === 'luck') {
        await handleModal(
          btn,
          textModal(`boost:luckm:${sid}`, 'Add a luck boost', [
            { id: 'mult', label: 'Luck multiplier', placeholder: '2.5' },
            { id: 'spins', label: 'How many server-wide spins', placeholder: '10' },
          ]),
          (submit) => {
            const mult = Number(submit.fields.getTextInputValue('mult'));
            const spins = Number(submit.fields.getTextInputValue('spins'));
            if (!Number.isFinite(mult) || mult < 1) throw new Error('Multiplier must be a number ≥ 1.');
            if (!Number.isInteger(spins) || spins < 1) throw new Error('Spins must be a whole number ≥ 1.');
            db.enqueueDevBoost(interaction.user.id, mult, spins, now);
            return `✅ Queued a x${fmtMult(mult)} luck boost for ${spins} spins.`;
          },
        );
        await refresh();
        return;
      }

      if (action === 'floor') {
        await handleModal(
          btn,
          textModal(`boost:floorm:${sid}`, 'Add a floor boost', [
            { id: 'value', label: 'Sacrifice value to model the boost on', placeholder: '1000000' },
          ]),
          (submit) => {
            const value = Number(submit.fields.getTextInputValue('value'));
            if (!Number.isFinite(value) || value <= 0) throw new Error('Value must be a number > 0.');
            const boost = engine.sacrificeBoost(value);
            db.enqueueBoost({
              userId: interaction.user.id,
              mult: boost.mult,
              spins: boost.spins,
              floorTier: boost.floorTier,
              floorUpgrade: boost.floorUpgrade,
              nowMs: now,
            });
            return (
              `✅ Queued a floor boost from ${fmtValue(value)}: **${rarities[boost.floorTier].name}+** ` +
              `with x${fmtMult(boost.mult)} luck for ${boost.spins} spins.`
            );
          },
        );
        await refresh();
        return;
      }

      if (action === 'clearsacs') {
        const cleared = db.clearSacrificeQueue();
        await btn.reply({
          content: `✅ Cleared ${cleared} active/queued boost${cleared === 1 ? '' : 's'}.`,
          flags: MessageFlags.Ephemeral,
        });
        await refresh();
        return;
      }
    })().catch((err) => console.error('boostmanagement component error:', err));
  });

  collector.on('end', () => {
    void interaction.editReply({ components: [] }).catch(() => {});
  });
}
