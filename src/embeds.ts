// Shared embed + component builders so every command presents a consistent face.

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { installUrl, releasesUrl } from './config.js';
import type { Release } from './github.js';

const COLOR = 0x9b59b6; // purple — matches the suite's in-game theme
const TAMPERMONKEY = 'https://www.tampermonkey.net/';

export function installButtonRow(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setStyle(ButtonStyle.Link)
      .setLabel('📥 Install (auto-updating)')
      .setURL(installUrl),
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('All releases').setURL(releasesUrl),
  );
}

function truncate(s: string, max: number): string {
  const text = s?.trim();
  if (!text) return '_No notes for this release._';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function firstLine(s: string): string {
  const line = (s || '').split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  return line.length > 120 ? `${line.slice(0, 119)}…` : line || '_No notes._';
}

function relTime(iso: string | null): string {
  if (!iso) return '';
  return `<t:${Math.floor(new Date(iso).getTime() / 1000)}:R>`;
}

// /script — file + install instructions + latest changelog.
export function scriptEmbed(latest: Release | null): EmbedBuilder {
  const e = new EmbedBuilder().setColor(COLOR).setTitle('flowr.fun — Utility Suite').setFooter({ text: 'shovelScript' });
  if (!latest) {
    return e.setDescription('No release has been published yet. Check back soon.');
  }
  e.setURL(latest.htmlUrl).setDescription(
    [
      `**Latest version:** \`${latest.tag}\``,
      '',
      '**Install (recommended — auto-updates):**',
      `1. Install [Tampermonkey](${TAMPERMONKEY}) (or Violentmonkey).`,
      '2. Click **📥 Install (auto-updating)** below — Tampermonkey opens its installer.',
      "3. Confirm, then reload flowr.fun. You're now always up to date.",
      '',
      'The attached `.user.js` is a raw copy — installing from the button is what keeps you auto-updated.',
    ].join('\n'),
  );
  e.addFields({ name: `What's new in ${latest.tag}`, value: truncate(latest.body, 1024) });
  if (latest.publishedAt) e.setTimestamp(new Date(latest.publishedAt));
  return e;
}

// /version — just the latest version + its notes.
export function versionEmbed(latest: Release | null): EmbedBuilder {
  const e = new EmbedBuilder().setColor(COLOR).setFooter({ text: 'shovelScript' });
  if (!latest) return e.setTitle('No releases yet').setDescription('No version has been published.');
  e.setTitle(`Latest version: ${latest.tag}`).setURL(latest.htmlUrl).setDescription(truncate(latest.body, 4000));
  if (latest.publishedAt) e.setTimestamp(new Date(latest.publishedAt));
  return e;
}

// /changelog <version> — notes for one release.
export function changelogEmbed(rel: Release): EmbedBuilder {
  const e = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle(rel.name)
    .setURL(rel.htmlUrl)
    .setDescription(truncate(rel.body, 4000))
    .setFooter({ text: 'shovelScript' });
  if (rel.publishedAt) e.setTimestamp(new Date(rel.publishedAt));
  return e;
}

// /changelog (no arg) — recent release history.
export function releaseListEmbed(releases: Release[]): EmbedBuilder {
  const e = new EmbedBuilder().setColor(COLOR).setTitle('Recent releases').setFooter({ text: 'shovelScript' });
  if (!releases.length) return e.setDescription('No releases yet.');
  const body = releases.map((r) => `**${r.tag}** ${relTime(r.publishedAt)}\n${firstLine(r.body)}`).join('\n\n');
  return e.setDescription(truncate(body, 4000));
}

// The static pinned install message — deliberately version-agnostic so it never
// goes stale: the install URL always resolves to the newest release.
export function pinnedInstallEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(COLOR)
    .setTitle('Install — flowr.fun Utility Suite')
    .setDescription(
      [
        "This installs the **latest** version and **auto-updates** forever — install once and you're always current.",
        '',
        `1. Install [Tampermonkey](${TAMPERMONKEY}) (or Violentmonkey).`,
        '2. Click **📥 Install (auto-updating)** below.',
        '3. Confirm in Tampermonkey, then reload flowr.fun.',
        '',
        'New versions arrive automatically — no need to reinstall. Use **/version** to see what changed.',
      ].join('\n'),
    )
    .setFooter({ text: 'shovelScript • always up to date' });
}
