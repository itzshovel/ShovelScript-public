// /inventory — public, button-paginated view of a player's petal collection.

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type User,
} from 'discord.js';
import * as db from '../spin/db.js';
import { buildInventoryView, type InventoryView } from '../spin/inventory.js';

export const data = new SlashCommandBuilder()
  .setName('inventory')
  .setDescription('Browse a petal collection page by page.')
  .addUserOption((o) => o.setName('user').setDescription('Whose inventory (default: yours)'));

function pageEmbed(target: User, view: InventoryView, page: number): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(view.color)
    .setTitle(`${target.username}'s inventory`)
    .setDescription(`${view.summary}\n\n${view.pages[page]}`)
    .setFooter({ text: `Page ${page + 1}/${view.pages.length}` });
}

function controls(sid: string, page: number, pageCount: number): ActionRowBuilder<ButtonBuilder> {
  const first = page === 0;
  const last = page === pageCount - 1;
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`inv:first:${sid}`).setLabel('⏮').setStyle(ButtonStyle.Secondary).setDisabled(first),
    new ButtonBuilder().setCustomId(`inv:prev:${sid}`).setLabel('◀').setStyle(ButtonStyle.Primary).setDisabled(first),
    new ButtonBuilder()
      .setCustomId(`inv:page:${sid}`)
      .setLabel(`${page + 1}/${pageCount}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
    new ButtonBuilder().setCustomId(`inv:next:${sid}`).setLabel('▶').setStyle(ButtonStyle.Primary).setDisabled(last),
    new ButtonBuilder().setCustomId(`inv:last:${sid}`).setLabel('⏭').setStyle(ButtonStyle.Secondary).setDisabled(last),
  );
}

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.inGuild()) {
    await interaction.reply({ content: 'Run this in the server.', flags: MessageFlags.Ephemeral });
    return;
  }

  const target = interaction.options.getUser('user') ?? interaction.user;
  const view = buildInventoryView(db.getUser(target.id), db.getCollection(target.id));

  if (view.stacks === 0) {
    await interaction.reply({
      content: `${target.id === interaction.user.id ? 'You have' : `${target.username} has`} no petals yet. Try /spin!`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const sid = interaction.id;
  let page = 0;

  await interaction.reply({
    embeds: [pageEmbed(target, view, page)],
    components: [controls(sid, page, view.pages.length)],
    allowedMentions: { parse: [] },
  });
  const message = await interaction.fetchReply();

  const collector = message.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: 300_000,
  });

  collector.on('collect', (btn) => {
    void (async () => {
      if (btn.user.id !== interaction.user.id) {
        await btn.reply({
          content: 'Run /inventory yourself to browse at your own pace.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const action = btn.customId.split(':')[1];
      if (action === 'first') page = 0;
      else if (action === 'prev') page = Math.max(0, page - 1);
      else if (action === 'next') page = Math.min(view.pages.length - 1, page + 1);
      else if (action === 'last') page = view.pages.length - 1;
      await btn.update({
        embeds: [pageEmbed(target, view, page)],
        components: [controls(sid, page, view.pages.length)],
      });
    })().catch((err) => console.error('inventory pagination error:', err));
  });

  collector.on('end', () => {
    void interaction.editReply({ components: [] }).catch(() => {});
  });
}
