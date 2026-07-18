import {
  GuildMemberRoleManager,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { config } from '../config.js';
import { installButtonRow, pinnedInstallEmbed } from '../embeds.js';

export const data = new SlashCommandBuilder()
  .setName('setup')
  .setDescription('Post and pin the static install message in this channel (staff only).');

/** Whether the invoking member holds the configured setup role. Handles both shapes of
 *  `interaction.member`: a GuildMember (roles is a manager) or the raw API member (roles is a
 *  string[] of role ids). */
function hasSetupRole(interaction: ChatInputCommandInteraction): boolean {
  const roles = interaction.member?.roles;
  if (!roles) return false;
  if (roles instanceof GuildMemberRoleManager) return roles.cache.has(config.setupRoleId);
  return Array.isArray(roles) ? roles.includes(config.setupRoleId) : false;
}

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.inGuild()) {
    await interaction.reply({ content: 'Run this in a server text channel.', flags: MessageFlags.Ephemeral });
    return;
  }
  if (!hasSetupRole(interaction)) {
    await interaction.reply({
      content: `You need the <@&${config.setupRoleId}> role to run /setup.`,
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] }, // show the role name without pinging it
    });
    return;
  }

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
