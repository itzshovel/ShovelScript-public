// /testspin — bugtest harness: render a predetermined petal + rarity exactly as
// /spin would (value math, flair, icon, effect note), without touching the
// database, cooldown, or effects. Admin only.

import {
  AttachmentBuilder,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import {
  displayName,
  findPetal,
  findTier,
  MISSILE_FAMILY,
  petalImage,
  petals,
  rarities,
  rarityColor,
} from '../spin/data.js';
import * as db from '../spin/db.js';
import * as engine from '../spin/engine.js';
import { flairBanner, flairFor, flairTitle, oddsText, recordLines } from '../spin/flair.js';
import { fmtSigned, fmtValue } from '../spin/format.js';

export const data = new SlashCommandBuilder()
  .setName('testspin')
  .setDescription('Bugtest: render a chosen petal + rarity as /spin would. Records nothing (admin only).')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addStringOption((o) =>
    o.setName('rarity').setDescription('Rarity name or tier index (0-68), e.g. "Omega" or 8').setRequired(true),
  )
  .addStringOption((o) =>
    o.setName('petal').setDescription('Petal name, e.g. "Blood Rose" or "Shiny Cash"').setRequired(true),
  )
  .addBooleanOption((o) =>
    o.setName('public').setDescription('Post publicly instead of only to you (default: no)'),
  );

function petalSuggestions(input: string): string {
  const s = input.trim().toLowerCase();
  const near = petals.filter((p) => p.name.toLowerCase().includes(s)).slice(0, 5);
  return near.length ? ` Did you mean: ${near.map((p) => p.name).join(', ')}?` : '';
}

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.inGuild()) {
    await interaction.reply({ content: 'Run this in the server.', flags: MessageFlags.Ephemeral });
    return;
  }
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({
      content: 'You need the **Administrator** permission to run /testspin.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const rarityInput = interaction.options.getString('rarity', true);
  const petalInput = interaction.options.getString('petal', true);
  const isPublic = interaction.options.getBoolean('public') ?? false;

  const tier = findTier(rarityInput);
  if (tier < 0) {
    await interaction.reply({
      content: `❌ Unknown rarity \`${rarityInput}\`. Use a name like "Omega" or an index 0-${rarities.length - 1}.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const petal = findPetal(petalInput);
  if (!petal) {
    await interaction.reply({
      content: `❌ Unknown petal \`${petalInput}\`.${petalSuggestions(petalInput)}`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Mirror the real /spin computation against the caller's live state, but
  // consume and record nothing.
  const now = Date.now();
  const user = db.getUser(interaction.user.id);
  const effects = db.getEffects(interaction.user.id);
  const serum = engine.serumActive(effects, now);
  const value = engine.computeValue(petal, tier, Math.max(user.highestTier, tier), serum);
  const outcome = engine.resolveEffect(petal, now, Math.random);

  const rarity = rarities[tier];
  const name = displayName(petal, tier);
  // Full flair visuals so staff can preview them, but no ping and no suspense
  // pause — a fake pull must never notify the role or stall the tester.
  const style = flairFor(tier, db.getFlairTiers());
  const flair = style.level > 0;

  const banner = flairBanner(style.level, rarity.name);
  const body = [
    ...(banner ? [banner] : []),
    `${interaction.user} spun a **${rarity.name}** **${name}**` + (value < 0 ? ' … ouch.' : '!'),
    ...recordLines(tier, user.highestTier, db.getServerHighestTier()),
  ];

  const embed = new EmbedBuilder()
    .setColor(rarityColor(tier))
    .setTitle(flairTitle(style.level, rarity.name, name))
    .setDescription(body.join('\n'))
    .addFields(
      { name: 'Value', value: fmtSigned(value), inline: true },
      { name: 'Total (unchanged)', value: fmtValue(user.totalValue), inline: true },
    )
    .setFooter({
      text:
        `🧪 TEST SPIN — nothing recorded • Tier ${tier + 1}/${rarities.length}` +
        (flair ? ` • ${oddsText(tier, db.getWeightOverrides())}` : ''),
    });

  if (serum && MISSILE_FAMILY.has(petal.name)) {
    embed.addFields({ name: 'Serum', value: '🧪 3x missile bonus applied', inline: true });
  }
  if (outcome.note) {
    embed.addFields({ name: 'Effect (not applied)', value: outcome.note });
  }
  if (petal.static) {
    const gate = petal.static.minTier > 0 ? rarities[petal.static.minTier].name : 'any tier';
    if (tier < petal.static.minTier) {
      embed.addFields({
        name: '⚠️ Impossible roll',
        value: `${petal.name} only drops at ${gate}+ in real spins.`,
      });
    }
  }

  const image = new AttachmentBuilder(petalImage(petal.name), { name: 'petal.png' });
  if (flair) embed.setImage('attachment://petal.png');
  else embed.setThumbnail('attachment://petal.png');

  await interaction.reply({
    embeds: [embed],
    files: [image],
    allowedMentions: { parse: [] },
    ...(isPublic ? {} : { flags: MessageFlags.Ephemeral }),
  });

  // Reactions only work on a real message — an ephemeral reply cannot hold them.
  if (isPublic && style.reactions.length > 0) {
    const sent = await interaction.fetchReply().catch(() => null);
    if (sent) {
      for (const emoji of style.reactions) await sent.react(emoji).catch(() => {});
    }
  }
}
