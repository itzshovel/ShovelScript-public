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
}

/** Applies one spin atomically: totals, collection stack, effect changes. */
export function recordSpin(rec: SpinRecord): void {
  db.exec('BEGIN');
  try {
    upsertUserStmt.run(rec.userId, rec.value, rec.tier, rec.nowMs, rec.stunnedUntilMs);
    upsertStackStmt.run(rec.userId, rec.petal, rec.tier);
    for (const id of rec.consumedEffectIds) deleteEffectStmt.run(id);
    for (const e of rec.newEffects) insertEffectStmt.run(rec.userId, e.kind, e.mult, e.startsMs, e.expiresMs);
    pruneEffectsStmt.run(rec.nowMs);
    db.exec('COMMIT');
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
