import { Client, Events, GatewayIntentBits, MessageFlags, type Interaction } from 'discord.js';
import { config } from './config.js';
import { commandMap } from './commands/index.js';
import { registerCommands } from './deploy-commands.js';

// Only the Guilds intent is needed: slash commands, sending, and pinning don't
// require message-content or member intents.
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, (c) => {
  console.log(`Logged in as ${c.user.tag} — serving guild ${config.guildId}`);
});

client.on(Events.InteractionCreate, async (interaction: Interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const command = commandMap.get(interaction.commandName);
  if (!command) return;

  try {
    await command.execute(interaction);
  } catch (err) {
    console.error(`Error handling /${interaction.commandName}:`, err);
    const msg = 'Something went wrong handling that. Try again in a moment.';
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(msg).catch(() => {});
    } else {
      await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
});

async function main(): Promise<void> {
  const n = await registerCommands();
  console.log(`Registered ${n} guild commands.`);
  await client.login(config.token);
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
