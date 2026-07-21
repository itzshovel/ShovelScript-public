# ShovelScript-public

Distribution home for the **ShovelScript** userscript (for flowr.fun).

This repo does two jobs:

1. **Hosts the userscript** as GitHub Release assets. The permanent install URL is
   `https://github.com/itzshovel/ShovelScript-public/releases/latest/download/shovelscript.user.js`
   — it always resolves to the newest release, and the userscript's baked-in
   `@updateURL`/`@downloadURL` point here, so Tampermonkey auto-updates every
   installed user with no action on their part.
2. **Runs the Discord bot** (this folder) that hands the script to users and
   announces new versions. Deployed on Railway from this repo.

The userscript **source** lives separately in the `FlowrUserScript` project; this
repo only receives built releases (via `npm run release` there) and runs the bot.

## Bot commands

- `/script` — the userscript + install instructions + latest changelog, with the
  `.user.js` attached as a raw copy.
- `/version` — the latest version and its notes.
- `/changelog [version]` — notes for a specific version, or recent history.
- `/help` — overview.
- `/setup` — *(Manage Server only)* posts and pins the static install message in
  the current channel. Needs the bot's **Manage Messages** permission to pin.

The bot is **stateless**: it reads the GitHub Releases API live (anonymous, with a
short in-memory cache) and holds no database. New-version announcements are fired
by the release script via a Discord channel webhook, not by the bot.

## Run locally

```bash
npm install
cp .env.example .env   # fill in DISCORD_TOKEN, APPLICATION_ID, GUILD_ID
npm run dev            # registers guild commands + logs in
```

## Deploy (Railway)

Railway is connected to this repo and redeploys on push. Build/start are driven by
`package.json` (`npm run build` → `tsc`, then `npm start` → `node dist/index.js`).
Set these as Railway **environment variables**:

- `DISCORD_TOKEN`
- `APPLICATION_ID`
- `GUILD_ID`

A Discord bot has no inbound HTTP port — Railway may report "no ports detected";
that's expected and harmless for a worker process.

Bot invite scopes: `bot` + `applications.commands`. Permissions: Send Messages,
Embed Links, Attach Files, and **Manage Messages** (for `/setup` pinning).

Claude was used to generate this README. No actual code was touched.
