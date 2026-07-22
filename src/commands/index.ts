import type { ChatInputCommandInteraction } from 'discord.js';
import * as script from './script.js';
import * as version from './version.js';
import * as changelog from './changelog.js';
import * as help from './help.js';
import * as setup from './setup.js';
import * as spin from './spin.js';
import * as collection from './collection.js';
import * as spintop from './spintop.js';
import * as spinodds from './spinodds.js';
import * as spinconfig from './spinconfig.js';
import * as testspin from './testspin.js';
import * as simulatespin from './simulatespin.js';
import * as inventory from './inventory.js';
import * as sacrifice from './sacrifice.js';
import * as boostmanagement from './boostmanagement.js';
import * as economymanagement from './economymanagement.js';

export interface Command {
  data: { name: string; toJSON(): unknown };
  execute(interaction: ChatInputCommandInteraction): Promise<void>;
}

export const commands: Command[] = [
  script, version, changelog, help, setup,
  spin, collection, spintop, spinodds, spinconfig, testspin, simulatespin, inventory, sacrifice, boostmanagement, economymanagement,
];
export const commandMap = new Map<string, Command>(commands.map((c) => [c.data.name, c]));
