// /spin — roll a random petal at a random rarity and add it to your collection.

import {
  AttachmentBuilder,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { displayName, MISSILE_FAMILY, petalImage, rarities, rarityColor } from '../spin/data.js';
import * as db from '../spin/db.js';
import * as engine from '../spin/engine.js';
import {
  flairBanner,
  flairFor,
  flairTitle,
  oddsText,
  recordLines,
  type FlairStyle,
} from '../spin/flair.js';
import { fmtMult, fmtSigned, fmtValue } from '../spin/format.js';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const data = new SlashCommandBuilder()
  .setName('spin')
  .setDescription('Spin for a random petal and add it to your collection.');

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.inGuild()) {
    await interaction.reply({ content: 'Run this in the server.', flags: MessageFlags.Ephemeral });
    return;
  }

  const spinChannelId = db.getSpinChannelId();
  if (spinChannelId && interaction.channelId !== spinChannelId) {
    await interaction.reply({
      content: `🎰 Spinning only works in <#${spinChannelId}>.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const now = Date.now();
  const userId = interaction.user.id;
  const user = db.getUser(userId);

  if (user.stunnedUntilMs > now) {
    await interaction.reply({
      content: `🥚 You are stunned by a Plastic Egg! You can spin again <t:${Math.ceil(user.stunnedUntilMs / 1000)}:R>.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const cooldownMs = db.getCooldownMs();
  const readyAt = user.lastSpinMs + cooldownMs;
  if (readyAt > now) {
    await interaction.reply({
      content: `⏳ Not yet — you can spin again <t:${Math.ceil(readyAt / 1000)}:R>.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const rng = Math.random;
  const effects = db.getEffects(userId);
  const boost = db.getSacrificeQueue()[0];
  // Dev boosts add luck; real (floor-based) sacrifices instead guarantee a
  // minimum tier — so their redistribution is actually delivered per spin.
  const globalBoosts =
    boost && boost.mult > 1
      ? [{ label: `Boost x${fmtMult(boost.mult)} (${boost.spinsLeft} left)`, mult: boost.mult }]
      : [];
  const { luck, consumedIds, parts } = engine.computeLuck(effects, now, globalBoosts);
  let tier = engine.rollTier(luck, db.getWeightOverrides(), rng);
  let floorNote: string | null = null;
  if (boost && boost.floorTier >= 0) {
    const floored = engine.rollFloorTier(boost, rng);
    if (tier < floored) tier = floored;
    floorNote = `🩸 Sacrifice floor: ${rarities[boost.floorTier].name}+ (${boost.spinsLeft} left)`;
  }
  const petal = engine.pickPetal(tier, rng);
  // Read before recordSpin — that call raises this roller's highest_tier, which
  // would otherwise swallow the record they just set.
  const serverBest = db.getServerHighestTier();
  const serum = engine.serumActive(effects, now);
  const value = engine.computeValue(petal, tier, Math.max(user.highestTier, tier), serum);
  const outcome = engine.resolveEffect(petal, now, rng);

  db.recordSpin({
    userId,
    petal: petal.name,
    tier,
    value,
    nowMs: now,
    stunnedUntilMs: outcome.stunnedUntilMs,
    consumedEffectIds: consumedIds,
    newEffects: outcome.newEffects,
    consumedSacrificeId: boost?.id ?? null,
  });

  const rarity = rarities[tier];
  const name = displayName(petal, tier);
  const style = flairFor(tier, db.getFlairTiers());
  const flair = style.level > 0;
  const newTotal = user.totalValue + value;

  const banner = flairBanner(style.level, rarity.name);
  const body = [
    ...(banner ? [banner] : []),
    `${interaction.user} spun a **${rarity.name}** **${name}**` + (value < 0 ? ' … ouch.' : '!'),
    ...recordLines(tier, user.highestTier, serverBest),
  ];

  const embed = new EmbedBuilder()
    .setColor(rarityColor(tier))
    .setTitle(flairTitle(style.level, rarity.name, name))
    .setDescription(body.join('\n'))
    .addFields(
      { name: 'Value', value: fmtSigned(value), inline: true },
      { name: 'Total', value: fmtValue(newTotal), inline: true },
    )
    .setFooter({
      text:
        `Tier ${tier + 1}/${rarities.length} • Spin #${user.spinCount + 1}` +
        (flair ? ` • ${oddsText(tier, db.getWeightOverrides())}` : ''),
    });

  if (luck !== 1) {
    embed.addFields({ name: 'Luck', value: `x${fmtMult(luck)} (${parts.join(', ')})`, inline: true });
  }
  if (floorNote) {
    embed.addFields({ name: 'Sacrifice', value: floorNote, inline: true });
  }
  if (serum && MISSILE_FAMILY.has(petal.name)) {
    embed.addFields({ name: 'Serum', value: '🧪 3x missile bonus applied', inline: true });
  }
  if (outcome.note) {
    embed.addFields({ name: 'Effect', value: outcome.note });
  }

  const image = new AttachmentBuilder(petalImage(petal.name), { name: 'petal.png' });
  if (flair) embed.setImage('attachment://petal.png');
  else embed.setThumbnail('attachment://petal.png');

  const result = { embeds: [embed], files: [image], allowedMentions: { parse: [] } };
  if (style.delayMs > 0) {
    // Suspense reveal. The roll is already settled and recorded, so the pause
    // only delays the message — it cannot change the outcome or the cooldown.
    await interaction.reply({ content: '🎰 Rolling…', allowedMentions: { parse: [] } });
    await sleep(style.delayMs);
    await interaction.editReply({ content: null, ...result });
  } else {
    await interaction.reply(result);
  }

  await celebrate(interaction, style, `${interaction.user} just pulled a **${rarity.name}** **${name}**!`);
}

/** Ping first (the notification is the point), then decorate with reactions.
 *  The ping is a separate message rather than part of the revealed embed:
 *  Discord does not reliably notify for mentions introduced by an edit. Both
 *  steps are best-effort — a missing permission must not fail the spin. */
async function celebrate(
  interaction: ChatInputCommandInteraction,
  style: FlairStyle,
  announcement: string,
): Promise<void> {
  if (style.ping) {
    const roleId = db.getFlairPingRole();
    if (roleId) {
      await interaction
        .followUp({ content: `<@&${roleId}> ${announcement}`, allowedMentions: { roles: [roleId] } })
        .catch(() => {});
    }
  }
  if (style.reactions.length === 0) return;
  const sent = await interaction.fetchReply().catch(() => null);
  if (!sent) return;
  for (const emoji of style.reactions) {
    await sent.react(emoji).catch(() => {});
  }
}
