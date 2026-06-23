import {
  PermissionFlagsBits,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { installButtonRow, pinnedInstallEmbed } from '../embeds.js';

export const data = new SlashCommandBuilder()
  .setName('setup')
  .setDescription('Post and pin the static install message in this channel (admin only).')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const channel = interaction.channel;
  if (!channel || !channel.isTextBased() || channel.isDMBased() || !('send' in channel)) {
    await interaction.editReply('Run this in a server text channel.');
    return;
  }

  const msg = await channel.send({ embeds: [pinnedInstallEmbed()], components: [installButtonRow()] });
  try {
    await msg.pin();
    await interaction.editReply('Posted and pinned the install message. ✅');
  } catch {
    await interaction.editReply(
      "Posted the install message, but I couldn't pin it — grant me the **Manage Messages** permission and pin it manually, or re-run /setup.",
    );
  }
}
