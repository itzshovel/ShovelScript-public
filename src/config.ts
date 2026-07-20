// Central config + env validation. Throws on boot if a required var is missing,
// so a misconfigured deploy fails loudly instead of half-working.

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v.trim();
}

function optional(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim() !== '' ? v.trim() : fallback;
}

export const config = {
  token: required('DISCORD_TOKEN'),
  applicationId: required('APPLICATION_ID'),
  guildId: required('GUILD_ID'),
  // Only members with this role may run /setup (enforced at runtime in commands/setup.ts).
  // Override per-deploy with SETUP_ROLE_ID; defaults to the production staff role.
  setupRoleId: optional('SETUP_ROLE_ID', '1518909571748593684'),
  // SQLite file for the /spin minigame. On Railway, point this at a mounted
  // volume (e.g. /data/spin.db) so collections survive redeploys.
  spinDbPath: optional('SPIN_DB_PATH', 'data/spin.db'),
  // /economymanagement is restricted to this Discord user id.
  ownerId: optional('OWNER_ID', '1339885336918097944'),
  // Second verification factor for the economy reset: set this to the same
  // value as the usage worker's ADMIN_KEY wrangler secret. Empty disables the
  // reset action (recalculating totals still works).
  resetSecretKey: optional('RESET_SECRET_KEY', ''),
  github: {
    owner: optional('GITHUB_OWNER', 'itzshovel'),
    repo: optional('GITHUB_REPO', 'ShovelScript-public'),
    assetName: optional('ASSET_NAME', 'shovelscript.user.js'),
  },
};

// The permanent "latest" URLs — these never change as new versions ship, which is
// exactly why a static pinned install message stays correct forever.
export const repoUrl = `https://github.com/${config.github.owner}/${config.github.repo}`;
export const installUrl = `${repoUrl}/releases/latest/download/${config.github.assetName}`;
export const releasesUrl = `${repoUrl}/releases`;
