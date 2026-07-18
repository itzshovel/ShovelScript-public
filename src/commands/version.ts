import { MessageFlags, SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { getLatestRelease } from '../github.js';
import { installButtonRow, versionEmbed } from '../embeds.js';

export const data = new SlashCommandBuilder()
  .setName('version')
  .setDescription('Show the latest published version and its changelog.');

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const latest = await getLatestRelease();
  await interaction.editReply({ embeds: [versionEmbed(latest)], components: [installButtonRow()] });
}
