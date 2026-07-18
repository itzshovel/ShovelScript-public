import { MessageFlags, SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { getReleaseByTag, listReleases } from '../github.js';
import { changelogEmbed, releaseListEmbed } from '../embeds.js';

export const data = new SlashCommandBuilder()
  .setName('changelog')
  .setDescription('Show release notes for a version, or recent history if no version is given.')
  .addStringOption((o) =>
    o.setName('version').setDescription('e.g. 1.2.0 or v1.2.0').setRequired(false),
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const version = interaction.options.getString('version');

  if (version) {
    const rel = await getReleaseByTag(version);
    if (!rel) {
      await interaction.editReply(`No release found for \`${version}\`. Use **/changelog** with no version to list recent ones.`);
      return;
    }
    await interaction.editReply({ embeds: [changelogEmbed(rel)] });
    return;
  }

  const releases = await listReleases(10);
  await interaction.editReply({ embeds: [releaseListEmbed(releases)] });
}
