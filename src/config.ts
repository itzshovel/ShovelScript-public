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
  github: {
    owner: optional('GITHUB_OWNER', 'itzshovel'),
    repo: optional('GITHUB_REPO', 'shovelScript'),
    assetName: optional('ASSET_NAME', 'flowr-userscript.user.js'),
  },
};

// The permanent "latest" URLs — these never change as new versions ship, which is
// exactly why a static pinned install message stays correct forever.
export const repoUrl = `https://github.com/${config.github.owner}/${config.github.repo}`;
export const installUrl = `${repoUrl}/releases/latest/download/${config.github.assetName}`;
export const releasesUrl = `${repoUrl}/releases`;
