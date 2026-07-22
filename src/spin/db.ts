// SQLite persistence for the /spin minigame, on Node's built-in node:sqlite
// (no native deps). The DB file lives at config.spinDbPath — on Railway, set
// SPIN_DB_PATH to a mounted volume path so state survives redeploys.

import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.js';
import { gates, rarities } from './data.js';

const dbPath = resolve(config.spinDbPath);
mkdirSync(dirname(dbPath), { recursive: true });

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS spin_users (
    user_id TEXT PRIMARY KEY,
    total_value REAL NOT NULL DEFAULT 0,
    highest_tier INTEGER NOT NULL DEFAULT -1,
    spin_count INTEGER NOT NULL DEFAULT 0,
    last_spin_ms INTEGER NOT NULL DEFAULT 0,
    stunned_until_ms INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS spin_collection (
    user_id TEXT NOT NULL,
    petal TEXT NOT NULL,
    tier INTEGER NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, petal, tier)
  );
  CREATE TABLE IF NOT EXISTS spin_effects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    mult REAL NOT NULL DEFAULT 1,
    starts_ms INTEGER NOT NULL,
    expires_ms INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_spin_effects_user ON spin_effects(user_id);
  CREATE TABLE IF NOT EXISTS spin_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS spin_sacrifices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    petal TEXT NOT NULL,
    tier INTEGER NOT NULL,
    value REAL NOT NULL,
    mult REAL NOT NULL,
    spins_total INTEGER NOT NULL,
    spins_left INTEGER NOT NULL,
    created_ms INTEGER NOT NULL
  );
`);

// Migration: floor-based sacrifices (replaced the luck-multiplier model). A
// real sacrifice now floors boosted spins to floor_tier (with floor_upgrade
// chance of one tier higher); dev boosts keep mult and leave floor_tier = -1.
const sacCols = db.prepare('PRAGMA table_info(spin_sacrifices)').all() as Array<{ name: string }>;
if (!sacCols.some((c) => c.name === 'floor_tier')) {
  db.exec('ALTER TABLE spin_sacrifices ADD COLUMN floor_tier INTEGER NOT NULL DEFAULT -1');
  // Retire boosts still queued under the old model. Their solved mult ran to
  // x3.5e11 for a deep sacrifice, and with floor_tier defaulting to -1 the new
  // spin path would read them as dev luck boosts — flat odds across every tier
  // for the rest of their window. Runs once, only on a pre-migration database.
  db.exec('UPDATE spin_sacrifices SET spins_left = 0 WHERE spins_left > 0');
}
if (!sacCols.some((c) => c.name === 'floor_upgrade')) {
  db.exec('ALTER TABLE spin_sacrifices ADD COLUMN floor_upgrade REAL NOT NULL DEFAULT 0');
}

export interface SpinUser {
  userId: string;
  totalValue: number;
  highestTier: number;
  spinCount: number;
  lastSpinMs: number;
  stunnedUntilMs: number;
}

/** One-shot effects (clover, token) use expiresMs = -1: active until consumed. */
export interface EffectRow {
  id: number;
  kind: string;
  mult: number;
  startsMs: number;
  expiresMs: number;
}

export interface CollectionRow {
  petal: string;
  tier: number;
  count: number;
}

const getUserStmt = db.prepare('SELECT * FROM spin_users WHERE user_id = ?');
const serverHighestStmt = db.prepare('SELECT MAX(highest_tier) AS t FROM spin_users');
const upsertUserStmt = db.prepare(`
  INSERT INTO spin_users (user_id, total_value, highest_tier, spin_count, last_spin_ms, stunned_until_ms)
  VALUES (?, ?, ?, 1, ?, ?)
  ON CONFLICT(user_id) DO UPDATE SET
    total_value = total_value + excluded.total_value,
    highest_tier = MAX(highest_tier, excluded.highest_tier),
    spin_count = spin_count + 1,
    last_spin_ms = excluded.last_spin_ms,
    stunned_until_ms = MAX(stunned_until_ms, excluded.stunned_until_ms)
`);
const upsertStackStmt = db.prepare(`
  INSERT INTO spin_collection (user_id, petal, tier, count) VALUES (?, ?, ?, 1)
  ON CONFLICT(user_id, petal, tier) DO UPDATE SET count = count + 1
`);
const effectsStmt = db.prepare('SELECT * FROM spin_effects WHERE user_id = ?');
const deleteEffectStmt = db.prepare('DELETE FROM spin_effects WHERE id = ?');
const insertEffectStmt = db.prepare(
  'INSERT INTO spin_effects (user_id, kind, mult, starts_ms, expires_ms) VALUES (?, ?, ?, ?, ?)',
);
const pruneEffectsStmt = db.prepare('DELETE FROM spin_effects WHERE expires_ms > 0 AND expires_ms < ?');
const clearEffectsStmt = db.prepare('DELETE FROM spin_effects WHERE user_id = ?');
const liftStunStmt = db.prepare('UPDATE spin_users SET stunned_until_ms = 0 WHERE user_id = ?');
const setStunStmt = db.prepare(`
  INSERT INTO spin_users (user_id, stunned_until_ms) VALUES (?, ?)
  ON CONFLICT(user_id) DO UPDATE SET stunned_until_ms = excluded.stunned_until_ms
`);
const collectionStmt = db.prepare(
  'SELECT petal, tier, count FROM spin_collection WHERE user_id = ? ORDER BY tier DESC, count DESC, petal ASC',
);
const topStmt = db.prepare(
  'SELECT * FROM spin_users WHERE spin_count > 0 ORDER BY total_value DESC LIMIT ?',
);
const getStackStmt = db.prepare(
  'SELECT count FROM spin_collection WHERE user_id = ? AND petal = ? AND tier = ?',
);
const decStackStmt = db.prepare(
  'UPDATE spin_collection SET count = count - 1 WHERE user_id = ? AND petal = ? AND tier = ?',
);
const deleteEmptyStackStmt = db.prepare(
  'DELETE FROM spin_collection WHERE user_id = ? AND petal = ? AND tier = ? AND count <= 0',
);
const adjustTotalStmt = db.prepare('UPDATE spin_users SET total_value = total_value - ? WHERE user_id = ?');
const insertSacrificeStmt = db.prepare(`
  INSERT INTO spin_sacrifices (user_id, petal, tier, value, mult, spins_total, spins_left, created_ms, floor_tier, floor_upgrade)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const sacrificeQueueStmt = db.prepare(
  'SELECT * FROM spin_sacrifices WHERE spins_left > 0 ORDER BY id ASC',
);
const consumeSacrificeStmt = db.prepare(
  'UPDATE spin_sacrifices SET spins_left = spins_left - 1 WHERE id = ?',
);
const clearSacrificesStmt = db.prepare('DELETE FROM spin_sacrifices WHERE spins_left > 0');
const getCfgStmt = db.prepare('SELECT value FROM spin_config WHERE key = ?');
const setCfgStmt = db.prepare(
  'INSERT INTO spin_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
);

function rowToUser(userId: string, row: Record<string, unknown> | undefined): SpinUser {
  if (!row) {
    return { userId, totalValue: 0, highestTier: -1, spinCount: 0, lastSpinMs: 0, stunnedUntilMs: 0 };
  }
  return {
    userId,
    totalValue: Number(row.total_value),
    highestTier: Number(row.highest_tier),
    spinCount: Number(row.spin_count),
    lastSpinMs: Number(row.last_spin_ms),
    stunnedUntilMs: Number(row.stunned_until_ms),
  };
}

export function getUser(userId: string): SpinUser {
  return rowToUser(userId, getUserStmt.get(userId) as Record<string, unknown> | undefined);
}

/** Deepest tier anyone in the server has ever pulled; -1 if nobody has spun.
 *  Read this before recordSpin — that call raises the roller's highest_tier. */
export function getServerHighestTier(): number {
  const row = serverHighestStmt.get() as { t: number | null } | undefined;
  return row?.t ?? -1;
}

export function getEffects(userId: string): EffectRow[] {
  const rows = effectsStmt.all(userId) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: Number(r.id),
    kind: String(r.kind),
    mult: Number(r.mult),
    startsMs: Number(r.starts_ms),
    expiresMs: Number(r.expires_ms),
  }));
}

/** Grants an effect outcome (from engine.effectByKind) to a user, exactly as a
 *  matching petal pull would — inserting its effect rows and applying any stun.
 *  Used by admin tools. */
export function grantEffect(
  userId: string,
  outcome: {
    stunnedUntilMs: number;
    newEffects: Array<{ kind: string; mult: number; startsMs: number; expiresMs: number }>;
  },
): void {
  db.exec('BEGIN');
  try {
    for (const e of outcome.newEffects) insertEffectStmt.run(userId, e.kind, e.mult, e.startsMs, e.expiresMs);
    if (outcome.stunnedUntilMs > 0) setStunStmt.run(userId, outcome.stunnedUntilMs);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** Removes all of a user's active effects and lifts any Plastic Egg stun.
 *  Returns how many effect rows were cleared. */
export function clearEffects(userId: string): number {
  const n = Number(clearEffectsStmt.run(userId).changes);
  liftStunStmt.run(userId);
  return n;
}

/** Whether a Plastic Egg stun is currently keeping this user from spinning. */
export function isStunned(userId: string, nowMs: number): boolean {
  return getUser(userId).stunnedUntilMs > nowMs;
}

export interface SpinRecord {
  userId: string;
  petal: string;
  tier: number;
  value: number;
  nowMs: number;
  stunnedUntilMs: number; // 0 unless a Plastic Egg stun starts now
  consumedEffectIds: number[];
  newEffects: Array<{ kind: string; mult: number; startsMs: number; expiresMs: number }>;
  /** Active sacrifice boost that powered this spin (decrements its spins_left). */
  consumedSacrificeId?: number | null;
}

/** Applies one spin atomically: totals, collection stack, effect changes. */
export function recordSpin(rec: SpinRecord): void {
  db.exec('BEGIN');
  try {
    upsertUserStmt.run(rec.userId, rec.value, rec.tier, rec.nowMs, rec.stunnedUntilMs);
    upsertStackStmt.run(rec.userId, rec.petal, rec.tier);
    for (const id of rec.consumedEffectIds) deleteEffectStmt.run(id);
    for (const e of rec.newEffects) insertEffectStmt.run(rec.userId, e.kind, e.mult, e.startsMs, e.expiresMs);
    if (rec.consumedSacrificeId != null) consumeSacrificeStmt.run(rec.consumedSacrificeId);
    pruneEffectsStmt.run(rec.nowMs);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// --- sacrifices ------------------------------------------------------------

export interface SacrificeRow {
  id: number;
  userId: string;
  petal: string;
  tier: number;
  value: number;
  /** Luck multiplier folded into each boosted spin's roll. Real sacrifices scale
   *  it with their value; dev boosts set it directly. 1 means no luck boost. */
  mult: number;
  spinsTotal: number;
  spinsLeft: number;
  /** Guaranteed floor tier for boosted spins; -1 for dev (luck-only) boosts. */
  floorTier: number;
  /** Chance a boosted spin floors one tier higher (fractional smoothing). */
  floorUpgrade: number;
}

function rowToSacrifice(r: Record<string, unknown>): SacrificeRow {
  return {
    id: Number(r.id),
    userId: String(r.user_id),
    petal: String(r.petal),
    tier: Number(r.tier),
    value: Number(r.value),
    mult: Number(r.mult),
    spinsTotal: Number(r.spins_total),
    spinsLeft: Number(r.spins_left),
    floorTier: Number(r.floor_tier),
    floorUpgrade: Number(r.floor_upgrade),
  };
}

/** Pending sacrifices in activation order; index 0 is the active boost. */
export function getSacrificeQueue(): SacrificeRow[] {
  return (sacrificeQueueStmt.all() as Array<Record<string, unknown>>).map(rowToSacrifice);
}

export function getStackCount(userId: string, petal: string, tier: number): number {
  const row = getStackStmt.get(userId, petal, tier) as { count: number } | undefined;
  return row ? Number(row.count) : 0;
}

/** Snapshot the whole database next to itself (VACUUM INTO) and return the
 *  backup path. Called right before destructive operations. */
export function backupDatabase(nowMs: number): string {
  const stamp = new Date(nowMs).toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupPath = dbPath.replace(/\.db$/, '') + `-backup-${stamp}.db`;
  db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
  return backupPath;
}

/** Full economy reset: wipes users, collections, effects, and the sacrifice
 *  queue. Staff config (cooldown, flair, channel lock, odds overrides) is
 *  kept. Returns how many users were wiped. */
export function resetEconomy(): number {
  db.exec('BEGIN');
  try {
    const row = db.prepare('SELECT COUNT(*) AS n FROM spin_users').get() as { n: number };
    db.exec('DELETE FROM spin_users; DELETE FROM spin_collection; DELETE FROM spin_effects; DELETE FROM spin_sacrifices');
    db.exec('COMMIT');
    return Number(row.n);
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** Rewrites every player's total worth by revaluing the petals they currently
 *  own under the live value curve (used after balance retunes). History
 *  dependent pulls (Shiny Cash, serum bonuses) are revalued against the
 *  player's current highest tier with no serum. Returns players updated. */
export function recalculateEconomy(
  valueOf: (petal: string, tier: number, highestTier: number) => number,
): number {
  db.exec('BEGIN');
  try {
    const users = db
      .prepare('SELECT user_id, highest_tier FROM spin_users')
      .all() as Array<Record<string, unknown>>;
    const setTotalStmt = db.prepare('UPDATE spin_users SET total_value = ? WHERE user_id = ?');
    for (const u of users) {
      const userId = String(u.user_id);
      const highest = Number(u.highest_tier);
      let total = 0;
      for (const s of collectionStmt.all(userId) as Array<Record<string, unknown>>) {
        total += Number(s.count) * valueOf(String(s.petal), Number(s.tier), highest);
      }
      setTotalStmt.run(total, userId);
    }
    db.exec('COMMIT');
    return users.length;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** Admin boost: enqueues a sacrifice-style boost with no petal burned and no
 *  worth deducted. A luck-only boost leaves floorTier at -1; a floor boost
 *  carries both a floor and its multiplier, like a real sacrifice. */
export function enqueueBoost(p: {
  userId: string;
  mult: number;
  spins: number;
  floorTier: number;
  floorUpgrade: number;
  nowMs: number;
}): void {
  insertSacrificeStmt.run(p.userId, '(admin boost)', 0, 0, p.mult, p.spins, p.spins, p.nowMs, p.floorTier, p.floorUpgrade);
}

/** Luck-only admin boost (floor_tier = -1). Thin wrapper over enqueueBoost. */
export function enqueueDevBoost(userId: string, mult: number, spins: number, nowMs: number): void {
  enqueueBoost({ userId, mult, spins, floorTier: -1, floorUpgrade: 0, nowMs });
}

/** Removes every active and queued sacrifice boost. Returns how many. */
export function clearSacrificeQueue(): number {
  return Number(clearSacrificesStmt.run().changes);
}

/** Burns one petal from the user's stack, deducts its value from their total
 *  (negative values heal), and enqueues a floor-plus-multiplier boost. False if
 *  the stack is gone. */
export function performSacrifice(p: {
  userId: string;
  petal: string;
  tier: number;
  value: number;
  floorTier: number;
  floorUpgrade: number;
  mult: number;
  spins: number;
  nowMs: number;
}): boolean {
  db.exec('BEGIN');
  try {
    const owned = getStackStmt.get(p.userId, p.petal, p.tier) as { count: number } | undefined;
    if (!owned || Number(owned.count) <= 0) {
      db.exec('ROLLBACK');
      return false;
    }
    decStackStmt.run(p.userId, p.petal, p.tier);
    deleteEmptyStackStmt.run(p.userId, p.petal, p.tier);
    adjustTotalStmt.run(p.value, p.userId);
    // A real sacrifice carries both a floor and a value-scaled luck multiplier.
    insertSacrificeStmt.run(p.userId, p.petal, p.tier, p.value, p.mult, p.spins, p.spins, p.nowMs, p.floorTier, p.floorUpgrade);
    db.exec('COMMIT');
    return true;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function getCollection(userId: string): CollectionRow[] {
  const rows = collectionStmt.all(userId) as Array<Record<string, unknown>>;
  return rows.map((r) => ({ petal: String(r.petal), tier: Number(r.tier), count: Number(r.count) }));
}

export function getTop(limit: number): SpinUser[] {
  const rows = topStmt.all(limit) as Array<Record<string, unknown>>;
  return rows.map((r) => rowToUser(String(r.user_id), r));
}

// --- staff config (persisted; defaults here) -------------------------------

export const DEFAULT_COOLDOWN_MS = 3 * 60_000;

function cfgGet(key: string): string | undefined {
  const row = getCfgStmt.get(key) as { value: string } | undefined;
  return row?.value;
}

export function getCooldownMs(): number {
  const v = Number(cfgGet('cooldown_ms'));
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_COOLDOWN_MS;
}

export function setCooldownMs(ms: number): void {
  setCfgStmt.run('cooldown_ms', String(Math.round(ms)));
}

// Flair thresholds, lowest first. flair_tier keeps its original meaning as the
// entry level, so a server that already tuned it is untouched by the upgrade.
const FLAIR_KEYS = ['flair_tier', 'flair_tier_2', 'flair_tier_3'] as const;
const FLAIR_DEFAULTS = [gates.omega, gates.eternal, 30] as const; // Omega, Eternal, Prismatic

/** The three big-pull flair thresholds: [big, huge, insane]. */
export function getFlairTiers(): number[] {
  return FLAIR_KEYS.map((key, i) => {
    const v = Number(cfgGet(key));
    return Number.isInteger(v) && v >= 0 && v < rarities.length ? v : FLAIR_DEFAULTS[i];
  });
}

export function setFlairTiers(tiers: readonly number[]): void {
  FLAIR_KEYS.forEach((key, i) => setCfgStmt.run(key, String(tiers[i])));
}

/** Role pinged on top-level flair pulls; null = pings off (the default). */
export function getFlairPingRole(): string | null {
  const v = cfgGet('flair_ping_role');
  return v ? v : null;
}

export function setFlairPingRole(roleId: string | null): void {
  setCfgStmt.run('flair_ping_role', roleId ?? '');
}

/** Channel /spin is locked to; null = usable anywhere. */
export function getSpinChannelId(): string | null {
  const v = cfgGet('spin_channel_id');
  return v ? v : null;
}

export function setSpinChannelId(id: string | null): void {
  setCfgStmt.run('spin_channel_id', id ?? '');
}

/** Staff odds overrides: tier index -> weight multiplier (1 = default, 0 = disabled). */
export function getWeightOverrides(): Record<number, number> {
  try {
    return JSON.parse(cfgGet('weight_overrides') ?? '{}') as Record<number, number>;
  } catch {
    return {};
  }
}

export function setWeightOverride(tier: number, mult: number): void {
  const map = getWeightOverrides();
  if (mult === 1) delete map[tier];
  else map[tier] = mult;
  setCfgStmt.run('weight_overrides', JSON.stringify(map));
}

export function resetWeightOverrides(): void {
  setCfgStmt.run('weight_overrides', '{}');
}

/** Chat command prefix for message commands ("!" by default). */
export function getPrefix(): string {
  const v = cfgGet('chat_prefix');
  return v ? v : '!';
}

export function setPrefix(prefix: string): void {
  setCfgStmt.run('chat_prefix', prefix);
}
