// Registers slash commands to the single configured guild. Guild-scoped commands
// appear instantly (no ~1h global propagation). Called on startup so the live
// command set always matches the code; can also be run standalone.

import { fileURLToPath } from 'node:url';
import { REST, Routes } from 'discord.js';
import { config } from './config.js';
import { commands } from './commands/index.js';

export async function registerCommands(): Promise<number> {
  const rest = new REST({ version: '10' }).setToken(config.token);
  const body = commands.map((c) => c.data.toJSON());
  await rest.put(Routes.applicationGuildCommands(config.applicationId, config.guildId), { body });
  return body.length;
}

// Allow `npm run register` to invoke this file directly.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  registerCommands()
    .then((n) => {
      console.log(`Registered ${n} guild commands to ${config.guildId}.`);
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
