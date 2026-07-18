import { AttachmentBuilder, MessageFlags, SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { config } from '../config.js';
import { downloadAsset, getLatestRelease } from '../github.js';
import { installButtonRow, scriptEmbed } from '../embeds.js';

export const data = new SlashCommandBuilder()
  .setName('script')
  .setDescription('Get the flowr.fun userscript + install instructions (always the latest version).');

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const latest = await getLatestRelease();

  const files: AttachmentBuilder[] = [];
  if (latest) {
    const asset = latest.assets.find((a) => a.name === config.github.assetName) ?? latest.assets[0];
    if (asset) {
      // Attachment is best-effort — the install button is the real (auto-updating) path.
      try {
        const buf = await downloadAsset(asset.url);
        files.push(new AttachmentBuilder(buf, { name: config.github.assetName }));
      } catch {
        /* ignore: still send the embed + install button */
      }
    }
  }

  await interaction.editReply({ embeds: [scriptEmbed(latest)], components: [installButtonRow()], files });
}
