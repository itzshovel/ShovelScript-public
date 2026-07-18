// /collection — view a player's petal collection, grouped by rarity.
// Static single-page view; /inventory is the button-paginated browser.

import {
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import * as db from '../spin/db.js';
import { buildInventoryView } from '../spin/inventory.js';

export const data = new SlashCommandBuilder()
  .setName('collection')
  .setDescription('View a petal collection from /spin.')
  .addUserOption((o) => o.setName('user').setDescription('Whose collection (default: yours)'))
  .addIntegerOption((o) => o.setName('page').setDescription('Page number').setMinValue(1));

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

  const page = Math.min(interaction.options.getInteger('page') ?? 1, view.pages.length);

  const embed = new EmbedBuilder()
    .setColor(view.color)
    .setTitle(`${target.username}'s collection`)
    .setDescription(`${view.summary}\n\n${view.pages[page - 1]}`)
    .setFooter({ text: `Page ${page}/${view.pages.length}` });

  await interaction.reply({ embeds: [embed], allowedMentions: { parse: [] } });
}
