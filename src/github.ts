// Thin GitHub Releases client. Reads anonymously (the repo is public) and caches
// responses in-memory for a short TTL so a burst of commands collapses to ~1 real
// API call, keeping us well under the 60 req/hr anonymous limit. No token to expire.

import { config } from './config.js';

export interface ReleaseAsset {
  name: string;
  url: string;
  size: number;
}

export interface Release {
  tag: string;
  name: string;
  body: string;
  htmlUrl: string;
  publishedAt: string | null;
  assets: ReleaseAsset[];
}

const API = 'https://api.github.com';
const TTL_MS = 45_000;
const UA = `${config.github.repo}-bot`;

interface CacheEntry {
  value: unknown;
  expires: number;
}
const cache = new Map<string, CacheEntry>();

async function cached<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value as T;
  const value = await fetcher();
  cache.set(key, { value, expires: Date.now() + TTL_MS });
  return value;
}

function mapRelease(r: any): Release {
  return {
    tag: r.tag_name,
    name: r.name || r.tag_name,
    body: r.body || '',
    htmlUrl: r.html_url,
    publishedAt: r.published_at ?? null,
    assets: (r.assets || []).map((a: any) => ({
      name: a.name,
      url: a.browser_download_url,
      size: a.size,
    })),
  };
}

async function gh(path: string): Promise<any> {
  const res = await fetch(`${API}/repos/${config.github.owner}/${config.github.repo}${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': UA,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (res.status === 404) return null;
  if (res.status === 403) {
    throw new Error('GitHub API rate limit reached. Try again in a minute.');
  }
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${res.statusText}`);
  return res.json();
}

export function getLatestRelease(): Promise<Release | null> {
  return cached('latest', async () => {
    const r = await gh('/releases/latest');
    return r ? mapRelease(r) : null;
  });
}

export function getReleaseByTag(tag: string): Promise<Release | null> {
  const withV = tag.startsWith('v') ? tag : `v${tag}`;
  return cached(`tag:${withV}`, async () => {
    // Try the v-prefixed tag first (our convention), then the raw input as a fallback.
    let r = await gh(`/releases/tags/${encodeURIComponent(withV)}`);
    if (!r && withV !== tag) r = await gh(`/releases/tags/${encodeURIComponent(tag)}`);
    return r ? mapRelease(r) : null;
  });
}

export function listReleases(limit = 10): Promise<Release[]> {
  return cached(`list:${limit}`, async () => {
    const r = await gh(`/releases?per_page=${limit}`);
    return Array.isArray(r) ? r.map(mapRelease) : [];
  });
}

export function downloadAsset(url: string): Promise<Buffer> {
  return cached(`asset:${url}`, async () => {
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error(`Asset download failed: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  });
}
