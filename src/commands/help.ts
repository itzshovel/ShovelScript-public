import { EmbedBuilder, SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { installButtonRow } from '../embeds.js';

export const data = new SlashCommandBuilder()
  .setName('help')
  .setDescription('How this bot and the userscript work.');

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const e = new EmbedBuilder()
    .setColor(0x9b59b6)
    .setTitle('flowr.fun Utility Suite — Help')
    .setDescription(
      [
        '**/script** — get the userscript + install instructions (always the latest build).',
        '**/version** — the latest version number and what changed.',
        '**/changelog** `[version]` — release notes for a version, or recent history.',
        '**/help** — this message.',
        '',
        'Install via the **📥 button** and Tampermonkey keeps you auto-updated — no need to come back here for new versions.',
      ].join('\n'),
    )
    .setFooter({ text: 'shovelScript' });
  await interaction.reply({ embeds: [e], components: [installButtonRow()] });
}
