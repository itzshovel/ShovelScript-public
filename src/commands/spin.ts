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
import { fmtMult, fmtSigned, fmtValue } from '../spin/format.js';

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
  const sacrifice = db.getSacrificeQueue()[0];
  const globalBoosts = sacrifice
    ? [{ label: `Sacrifice x${fmtMult(sacrifice.mult)} (${sacrifice.spinsLeft} left)`, mult: sacrifice.mult }]
    : [];
  const { luck, consumedIds, parts } = engine.computeLuck(effects, now, globalBoosts);
  const tier = engine.rollTier(luck, db.getWeightOverrides(), rng);
  const petal = engine.pickPetal(tier, rng);
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
    consumedSacrificeId: sacrifice?.id ?? null,
  });

  const rarity = rarities[tier];
  const name = displayName(petal, tier);
  const flair = tier >= db.getFlairTier();
  const newTotal = user.totalValue + value;

  const embed = new EmbedBuilder()
    .setColor(rarityColor(tier))
    .setTitle(flair ? `🎉 BIG PULL — ${rarity.name} ${name}!` : `${rarity.name} ${name}`)
    .setDescription(
      `${interaction.user} spun a **${rarity.name}** **${name}**` +
        (value < 0 ? ' … ouch.' : '!'),
    )
    .addFields(
      { name: 'Value', value: fmtSigned(value), inline: true },
      { name: 'Total', value: fmtValue(newTotal), inline: true },
    )
    .setFooter({ text: `Tier ${tier + 1}/${rarities.length} • Spin #${user.spinCount + 1}` });

  if (luck !== 1) {
    embed.addFields({ name: 'Luck', value: `x${fmtMult(luck)} (${parts.join(', ')})`, inline: true });
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

  await interaction.reply({ embeds: [embed], files: [image], allowedMentions: { parse: [] } });
}
