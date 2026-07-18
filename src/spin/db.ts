// SQLite persistence for the /spin minigame, on Node's built-in node:sqlite
// (no native deps). The DB file lives at config.spinDbPath — on Railway, set
// SPIN_DB_PATH to a mounted volume path so state survives redeploys.

import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.js';
import { gates } from './data.js';

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
  INSERT INTO spin_sacrifices (user_id, petal, tier, value, mult, spins_total, spins_left, created_ms)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
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
  mult: number;
  spinsTotal: number;
  spinsLeft: number;
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

/** Dev/admin boost: enqueues a sacrifice-style luck boost with no petal burned
 *  and no worth deducted. */
export function enqueueDevBoost(userId: string, mult: number, spins: number, nowMs: number): void {
  insertSacrificeStmt.run(userId, '(dev boost)', 0, 0, mult, spins, spins, nowMs);
}

/** Removes every active and queued sacrifice boost. Returns how many. */
export function clearSacrificeQueue(): number {
  return Number(clearSacrificesStmt.run().changes);
}

/** Burns one petal from the user's stack, deducts its value from their total
 *  (negative values heal), and enqueues the boost. False if the stack is gone. */
export function performSacrifice(p: {
  userId: string;
  petal: string;
  tier: number;
  value: number;
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
    insertSacrificeStmt.run(p.userId, p.petal, p.tier, p.value, p.mult, p.spins, p.spins, p.nowMs);
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

export function getFlairTier(): number {
  const v = Number(cfgGet('flair_tier'));
  return Number.isInteger(v) && v >= 0 ? v : gates.omega;
}

export function setFlairTier(tier: number): void {
  setCfgStmt.run('flair_tier', String(tier));
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
