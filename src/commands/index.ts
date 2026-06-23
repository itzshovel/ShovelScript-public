import type { ChatInputCommandInteraction } from 'discord.js';
import * as script from './script.js';
import * as version from './version.js';
import * as changelog from './changelog.js';
import * as help from './help.js';
import * as setup from './setup.js';

export interface Command {
  data: { name: string; toJSON(): unknown };
  execute(interaction: ChatInputCommandInteraction): Promise<void>;
}

export const commands: Command[] = [script, version, changelog, help, setup];
export const commandMap = new Map<string, Command>(commands.map((c) => [c.data.name, c]));
