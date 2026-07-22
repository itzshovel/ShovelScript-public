// /sacrifice — burn a petal from your collection for a server-wide boost. Each
// boosted spin is floored to a guaranteed minimum rarity that redistributes
// ~80% of the sacrificed value back reliably, and also carries a value-scaled
// luck multiplier that lifts spins which would already beat the floor even
// higher. Duration scales with the value. Boosts queue: one is active at a
// time, consumed by anyone's spins.

import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import {
  displayName,
  findPetal,
  findTier,
  petalImage,
  petals,
  rarities,
  rarityColor,
} from '../spin/data.js';
import * as db from '../spin/db.js';
import * as engine from '../spin/engine.js';
import { fmtMult, fmtValue } from '../spin/format.js';

export const data = new SlashCommandBuilder()
  .setName('sacrifice')
  .setDescription('Burn a petal from your collection for a server-wide luck boost.')
  .addStringOption((o) =>
    o.setName('petal').setDescription('Petal name from your collection').setRequired(true),
  )
  .addStringOption((o) =>
    o.setName('rarity').setDescription('Rarity of the stack, e.g. "Omega" or 8').setRequired(true),
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

  const petalInput = interaction.options.getString('petal', true);
  const rarityInput = interaction.options.getString('rarity', true);

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

  const userId = interaction.user.id;
  const owned = db.getStackCount(userId, petal.name, tier);
  if (owned <= 0) {
    await interaction.reply({
      content: `❌ You don't have a **${rarities[tier].name} ${petal.name}** in your collection. Check /inventory.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const user = db.getUser(userId);
  const value = engine.computeValue(petal, tier, Math.max(user.highestTier, tier), false);
  const { floorTier, floorUpgrade, spins, mult } = engine.sacrificeBoost(Math.abs(value));
  const name = displayName(petal, tier);
  const queueAhead = db.getSacrificeQueue().length;

  const worthNote =
    value >= 0
      ? `Your total worth **drops by ${fmtValue(value)}**.`
      : `The curse is purged: your total worth **rises by ${fmtValue(-value)}**.`;
  const queueNote = queueAhead > 0 ? `\nIt queues behind ${queueAhead} active/pending boost${queueAhead > 1 ? 's' : ''}.` : '';
  const boostNote = mult > 1 ? ` Lucky spins get a **x${fmtMult(mult)} luck** push to reach even higher.` : '';

  const preview = new EmbedBuilder()
    .setColor(rarityColor(tier))
    .setTitle(`🩸 Sacrifice ${rarities[tier].name} ${name}?`)
    .setDescription(
      `Worth ${fmtValue(value)} (you own ×${owned}). ${worthNote}\n` +
        `For the next **${spins} spins server-wide**, every spin is guaranteed to land at ` +
        `least **${rarities[floorTier].name}** rarity (anyone's spins, often higher).${boostNote}${queueNote}\n\n` +
        `This cannot be undone.`,
    );

  const sid = interaction.id;
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`sac:confirm:${sid}`).setLabel('🩸 Sacrifice').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`sac:cancel:${sid}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
  );

  await interaction.reply({ embeds: [preview], components: [row], allowedMentions: { parse: [] } });
  const message = await interaction.fetchReply();

  const collector = message.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: 60_000,
  });

  collector.on('collect', (btn) => {
    void (async () => {
      if (btn.user.id !== userId) {
        await btn.reply({
          content: `Only ${interaction.user.username} can decide this sacrifice.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      collector.stop('answered');

      if (btn.customId !== `sac:confirm:${sid}`) {
        await btn.update({ content: 'Sacrifice cancelled.', embeds: [], components: [] });
        return;
      }

      const ok = db.performSacrifice({
        userId,
        petal: petal.name,
        tier,
        value,
        floorTier,
        floorUpgrade,
        mult,
        spins,
        nowMs: Date.now(),
      });
      if (!ok) {
        await btn.update({ content: '❌ That stack is gone (already sacrificed?).', embeds: [], components: [] });
        return;
      }

      const nowQueued = db.getSacrificeQueue();
      const position = nowQueued.findIndex((s) => s.userId === userId && s.petal === petal.name && s.tier === tier);
      const isActive = position <= 0;

      const announce = new EmbedBuilder()
        .setColor(rarityColor(tier))
        .setTitle(`🩸 ${interaction.user.username} sacrificed a ${rarities[tier].name} ${name}!`)
        .setDescription(
          `Worth ${fmtValue(value)} — the server's next **${spins} spins** are floored to ` +
            `**${rarities[floorTier].name}+** rarity${mult > 1 ? ` with a **x${fmtMult(mult)} luck** boost on top` : ''}.\n` +
            (isActive ? 'The floor is **live now** — go spin!' : `Queued: it activates after the current boost${nowQueued.length > 2 ? 'es' : ''} run out.`),
        )
        .setThumbnail('attachment://petal.png')
        .setFooter({ text: 'Sacrifice boosts apply to everyone\'s spins' });

      await btn.update({
        embeds: [announce],
        files: [new AttachmentBuilder(petalImage(petal.name), { name: 'petal.png' })],
        components: [],
      });
    })().catch((err) => console.error('sacrifice confirm error:', err));
  });

  collector.on('end', (_collected, reason) => {
    if (reason !== 'answered') {
      void interaction
        .editReply({ content: '🩸 Sacrifice offer expired.', embeds: [], components: [] })
        .catch(() => {});
    }
  });
}
