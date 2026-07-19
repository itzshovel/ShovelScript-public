// Chat prefix commands: "!spin", "!sacrifice Blood Rose Omega", … Every slash
// command except /reseteconomy also works as a plain chat message. The prefix
// is staff-configurable via /spinconfig (stored in spin_config). A small
// adapter wraps the Message in the slice of ChatInputCommandInteraction the
// command modules actually use; replies are always public (never ephemeral)
// and never ping anyone.

import type {
  ChatInputCommandInteraction,
  Message,
  MessageCreateOptions,
  MessageEditOptions,
  MessageReplyOptions,
  User,
} from 'discord.js';
import { commandMap } from './commands/index.js';
import { findPetal, findTier } from './spin/data.js';
import * as db from './spin/db.js';

/** Parse failure with a player-facing usage hint. */
class UsageError extends Error {}

// --- option bag ------------------------------------------------------------

/** Duck-typed stand-in for interaction.options, backed by pre-parsed values. */
class PrefixOptions {
  constructor(private readonly values: Record<string, unknown>) {}

  private get(name: string, required: boolean): unknown {
    const v = this.values[name];
    if (v === undefined || v === null) {
      if (required) throw new Error(`Missing required option "${name}"`);
      return null;
    }
    return v;
  }

  getString(name: string, required = false): string | null {
    return this.get(name, required) as string | null;
  }
  getInteger(name: string, required = false): number | null {
    return this.get(name, required) as number | null;
  }
  getNumber(name: string, required = false): number | null {
    return this.get(name, required) as number | null;
  }
  getBoolean(name: string, required = false): boolean | null {
    return this.get(name, required) as boolean | null;
  }
  getUser(name: string, required = false): User | null {
    return this.get(name, required) as User | null;
  }
}

// --- interaction adapter ---------------------------------------------------

type AnyPayload = string | Record<string, unknown>;

/** Strip interaction-only fields (ephemeral flags) and suppress pings. */
function toSendable(payload: AnyPayload): Record<string, unknown> {
  const p: Record<string, unknown> = typeof payload === 'string' ? { content: payload } : { ...payload };
  delete p.flags; // ephemeral has no meaning in chat — everything is public
  const am = (p.allowedMentions as Record<string, unknown> | undefined) ?? { parse: [] };
  p.allowedMentions = { ...am, repliedUser: false };
  return p;
}

/** Wraps a chat message in the interaction surface the commands use: reply /
 *  editReply / followUp / fetchReply / deferReply, user, member, options. */
class PrefixContext {
  readonly options: PrefixOptions;
  deferred = false;
  replied = false;
  private sent: Message | null = null;

  constructor(
    private readonly source: Message<true>,
    values: Record<string, unknown>,
  ) {
    this.options = new PrefixOptions(values);
  }

  get user(): User {
    return this.source.author;
  }
  get member() {
    return this.source.member;
  }
  get memberPermissions() {
    return this.source.member?.permissions ?? null;
  }
  get channelId(): string {
    return this.source.channelId;
  }
  get id(): string {
    return this.source.id;
  }
  get client() {
    return this.source.client;
  }
  inGuild(): boolean {
    return true;
  }

  async reply(payload: AnyPayload): Promise<Message> {
    this.sent = await this.send(payload);
    this.replied = true;
    return this.sent;
  }

  async deferReply(): Promise<void> {
    this.deferred = true;
    await this.source.channel.sendTyping().catch(() => {});
  }

  async editReply(payload: AnyPayload): Promise<Message> {
    if (this.sent) {
      this.sent = await this.sent.edit(toSendable(payload) as MessageEditOptions);
      return this.sent;
    }
    return this.reply(payload); // deferred: first edit sends the message
  }

  async fetchReply(): Promise<Message> {
    if (!this.sent) throw new Error('No reply sent yet.');
    return this.sent;
  }

  async followUp(payload: AnyPayload): Promise<Message> {
    return this.send(payload);
  }

  private async send(payload: AnyPayload): Promise<Message> {
    const opts = toSendable(payload);
    try {
      return await this.source.reply(opts as MessageReplyOptions);
    } catch {
      // invoking message may have been deleted — fall back to a plain send
      return await this.source.channel.send(opts as MessageCreateOptions);
    }
  }
}

// --- per-command argument parsers -------------------------------------------

const MENTION_RE = /^<@!?(\d{15,21})>$/;
const ID_RE = /^\d{15,21}$/;

async function resolveUser(token: string, message: Message<true>): Promise<User> {
  const m = MENTION_RE.exec(token);
  const id = m ? m[1] : ID_RE.test(token) ? token : null;
  if (!id) throw new UsageError(`\`${token}\` is not a user mention or id.`);
  try {
    return await message.client.users.fetch(id);
  } catch {
    throw new UsageError(`Unknown user \`${token}\`.`);
  }
}

/** Split "<petal words> <rarity words>" by trying every split point against
 *  the catalog (petal names and rarity names both contain spaces). Falls back
 *  to "last word is the rarity" so the command's own error messages (with
 *  petal suggestions) fire on bad input. */
function splitPetalThenRarity(tokens: string[]): { petal: string; rarity: string } {
  for (let i = tokens.length - 1; i >= 1; i--) {
    const petal = tokens.slice(0, i).join(' ');
    const rarity = tokens.slice(i).join(' ');
    if (findPetal(petal) && findTier(rarity) >= 0) return { petal, rarity };
  }
  return { petal: tokens.slice(0, -1).join(' '), rarity: tokens[tokens.length - 1] };
}

/** Same as above with the rarity first (the /testspin argument order). */
function splitRarityThenPetal(tokens: string[]): { rarity: string; petal: string } {
  for (let i = 1; i < tokens.length; i++) {
    const rarity = tokens.slice(0, i).join(' ');
    const petal = tokens.slice(i).join(' ');
    if (findTier(rarity) >= 0 && findPetal(petal)) return { rarity, petal };
  }
  return { rarity: tokens[0], petal: tokens.slice(1).join(' ') };
}

type Parser = (
  tokens: string[],
  message: Message<true>,
  prefix: string,
) => Promise<Record<string, unknown>>;

/** Commands not listed here take no arguments (extra text is ignored). */
const parsers: Record<string, Parser> = {
  async changelog(tokens) {
    return { version: tokens.length ? tokens.join(' ') : null };
  },

  async collection(tokens, message, prefix) {
    const values: Record<string, unknown> = {};
    for (const token of tokens) {
      if (/^\d{1,4}$/.test(token)) values.page = Number(token);
      else if (values.user === undefined) values.user = await resolveUser(token, message);
      else throw new UsageError(`Usage: \`${prefix}collection [@user] [page]\``);
    }
    return values;
  },

  async inventory(tokens, message, prefix) {
    if (tokens.length === 0) return {};
    if (tokens.length > 1) throw new UsageError(`Usage: \`${prefix}inventory [@user]\``);
    return { user: await resolveUser(tokens[0], message) };
  },

  async sacrifice(tokens, _message, prefix) {
    if (tokens.length < 2) {
      throw new UsageError(`Usage: \`${prefix}sacrifice <petal> <rarity>\` — e.g. \`${prefix}sacrifice Blood Rose Omega\``);
    }
    return { ...splitPetalThenRarity(tokens) };
  },

  async testspin(tokens, _message, prefix) {
    if (tokens.length < 2) {
      throw new UsageError(`Usage: \`${prefix}testspin <rarity> <petal>\` — e.g. \`${prefix}testspin Omega Blood Rose\``);
    }
    // chat replies are always public, so mirror that in the "public" option
    return { ...splitRarityThenPetal(tokens), public: true };
  },

  async devsacrifice(tokens, _message, prefix) {
    const usage = new UsageError(`Usage: \`${prefix}devsacrifice <multiplier> <duration> [clear] [silent]\``);
    if (tokens.length < 2) throw usage;
    const multiplier = Number(tokens[0]);
    const duration = Number(tokens[1]);
    // mirror the slash command's option constraints (min 1, integer spins)
    if (!Number.isFinite(multiplier) || multiplier < 1) throw usage;
    if (!Number.isInteger(duration) || duration < 1) throw usage;
    const values: Record<string, unknown> = { multiplier, duration };
    for (const flag of tokens.slice(2)) {
      const f = flag.toLowerCase();
      if (f === 'clear') values.clear = true;
      else if (f === 'silent') values.silent = true;
      else throw usage;
    }
    return values;
  },
};

// --- dispatcher -------------------------------------------------------------

/** Handle a possible prefix command in a chat message. Safe to call for every
 *  MessageCreate; silently ignores anything that isn't a known command. */
export async function handlePrefixMessage(message: Message): Promise<void> {
  if (message.author.bot || !message.inGuild()) return;
  const prefix = db.getPrefix();
  if (!message.content.startsWith(prefix)) return;

  const body = message.content.slice(prefix.length).trim();
  if (!body) return;
  const tokens = body.split(/\s+/);
  const name = tokens.shift()!.toLowerCase();

  if (name === 'reseteconomy') {
    await message.reply({
      content: '🔒 /reseteconomy only works as a slash command.',
      allowedMentions: { parse: [], repliedUser: false },
    });
    return;
  }
  const command = commandMap.get(name);
  if (!command) return;

  let values: Record<string, unknown> = {};
  try {
    const parser = parsers[name];
    if (parser) values = await parser(tokens, message, prefix);
  } catch (err) {
    if (err instanceof UsageError) {
      await message.reply({ content: `❌ ${err.message}`, allowedMentions: { parse: [], repliedUser: false } });
      return;
    }
    throw err;
  }

  const ctx = new PrefixContext(message, values);
  try {
    // The adapter implements the interaction surface the commands use.
    await command.execute(ctx as unknown as ChatInputCommandInteraction);
  } catch (err) {
    console.error(`Error handling ${prefix}${name}:`, err);
    await ctx
      .followUp('Something went wrong handling that. Try again in a moment.')
      .catch(() => {});
  }
}
