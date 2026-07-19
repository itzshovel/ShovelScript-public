import { Client, Events, GatewayIntentBits, MessageFlags, type Interaction } from 'discord.js';
import { config } from './config.js';
import { commandMap } from './commands/index.js';
import { registerCommands } from './deploy-commands.js';
import { handlePrefixMessage } from './prefix.js';

// Guilds covers slash commands and sending. GuildMessages + MessageContent
// power the "!spin"-style chat commands — MessageContent is a privileged
// intent and must also be enabled on the bot's Developer Portal page.
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

client.once(Events.ClientReady, (c) => {
  console.log(`Logged in as ${c.user.tag} — serving guild ${config.guildId}`);
});

client.on(Events.MessageCreate, (message) => {
  void handlePrefixMessage(message).catch((err) => console.error('prefix command error:', err));
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
