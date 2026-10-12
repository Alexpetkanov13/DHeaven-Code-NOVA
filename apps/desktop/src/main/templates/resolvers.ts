/**
 * Version resolvers for the Minecraft templates. Live data comes from the official sources at generation time:
 *  - Fabric: meta.fabricmc.net (game + loader), maven.fabricmc.net (Fabric API), the official fabric-example-mod
 *    gradle.properties (Loom version Fabric recommends), piston-meta.mojang.com version JSON (required Java major).
 *  - Paper: fill.papermc.io v3 (versions + Java minimum), repo.papermc.io (paper-api artifact),
 *    plugins.gradle.org (run-paper plugin).
 * If any request fails, a pinned offline fallback is used and labelled as such.
 */
export type Fetch = (url: string) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
export interface ResolvedVersion { minecraft: string; javaMajor: number; deps: Record<string, string> }
export interface Resolution { resolver: string; source: 'live' | 'offline-fallback'; note: string; versions: ResolvedVersion[]; shared: Record<string, string>; errors: string[] }

export const OFFLINE_PINNED_AT = '2026-10-12';
export const FABRIC_FALLBACK: Resolution = {
  resolver: 'fabric', source: 'offline-fallback', errors: [],
  note: `Offline fallback: versions pinned on ${OFFLINE_PINNED_AT}; may be outdated — regenerate when online or update gradle.properties.`,
  shared: { loaderVersion: '0.19.5', loomVersion: '1.18-SNAPSHOT' },
  versions: [{ minecraft: '26.3', javaMajor: 25, deps: { fabricApiVersion: '0.162.0+26.3' } }],
};
export const PAPER_FALLBACK: Resolution = {
  resolver: 'paper', source: 'offline-fallback', errors: [],
  note: `Offline fallback: versions pinned on ${OFFLINE_PINNED_AT}; may be outdated — regenerate when online or update build.gradle.kts.`,
  shared: { runPaperVersion: '3.1.0' },
  versions: [
    { minecraft: '26.3', javaMajor: 25, deps: { paperApiVersion: '26.3.build.177-stable', apiVersion: '26.3' } },
    { minecraft: '1.21.11', javaMajor: 21, deps: { paperApiVersion: '1.21.11-R0.1-SNAPSHOT', apiVersion: '1.21.11' } },
  ],
};

async function get(f: Fetch, url: string): Promise<string> {
  const r = await f(url);
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
  return r.text();
}
const json = async <T>(f: Fetch, url: string) => JSON.parse(await get(f, url)) as T;
export const mavenVersions = (xml: string) => [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1]!);
/** "26.1.2" / "1.21.11" → numeric parts for comparison. */
const parts = (v: string) => v.split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : NaN));
export function cmpMc(a: string, b: string) { const x = parts(a), y = parts(b); for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] ?? 0) - (y[i] ?? 0); if (d) return d; } return 0; }

/** Fabric template layout = unobfuscated Minecraft (26.1+): no mappings, `net.fabricmc.fabric-loom`, plain `implementation`. */
export const FABRIC_MIN_MC = '26.1';
export async function resolveFabric(f: Fetch, max = 6): Promise<Resolution> {
  try {
    const [games, loaders, apiXml, exampleProps, manifest] = await Promise.all([
      json<{ version: string; stable: boolean }[]>(f, 'https://meta.fabricmc.net/v2/versions/game'),
      json<{ version: string; stable: boolean }[]>(f, 'https://meta.fabricmc.net/v2/versions/loader'),
      get(f, 'https://maven.fabricmc.net/net/fabricmc/fabric-api/fabric-api/maven-metadata.xml'),
      get(f, 'https://raw.githubusercontent.com/FabricMC/fabric-example-mod/HEAD/gradle.properties'),
      json<{ versions: { id: string; url: string }[] }>(f, 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'),
    ]);
    const loader = loaders.find((l) => l.stable)?.version; if (!loader) throw new Error('no stable Fabric loader');
    const loom = /^loom_version=(\S+)/m.exec(exampleProps)?.[1]; if (!loom) throw new Error('loom_version missing in fabric-example-mod gradle.properties');
    const api = mavenVersions(apiXml);
    const candidates = games.filter((g) => g.stable && /^\d+\.\d+(\.\d+)?$/.test(g.version) && cmpMc(g.version, FABRIC_MIN_MC) >= 0).slice(0, max);
    const versions: ResolvedVersion[] = [];
    for (const g of candidates) {
      const fapi = api.filter((v) => v.endsWith(`+${g.version}`)).pop(); if (!fapi) continue; // Fabric API not released for it yet
      const url = manifest.versions.find((v) => v.id === g.version)?.url; if (!url) continue;
      const vj = await json<{ javaVersion?: { majorVersion: number } }>(f, url);
      versions.push({ minecraft: g.version, javaMajor: vj.javaVersion?.majorVersion ?? 25, deps: { fabricApiVersion: fapi } });
    }
    if (!versions.length) throw new Error('no Minecraft version with a Fabric API build found');
    return { resolver: 'fabric', source: 'live', errors: [], note: `Live: Fabric meta, Fabric maven, fabric-example-mod (Loom ${loom}), Mojang version metadata — fetched ${new Date().toISOString()}`, shared: { loaderVersion: loader, loomVersion: loom }, versions };
  } catch (e) {
    return { ...FABRIC_FALLBACK, errors: [e instanceof Error ? e.message : String(e)] };
  }
}

export async function resolvePaper(f: Fetch, max = 6): Promise<Resolution> {
  try {
    const [vs, apiXml, rpXml] = await Promise.all([
      json<{ versions: { version: { id: string; support?: { status: string }; java?: { version?: { minimum?: number } } } }[] }>(f, 'https://fill.papermc.io/v3/projects/paper/versions'),
      get(f, 'https://repo.papermc.io/repository/maven-public/io/papermc/paper/paper-api/maven-metadata.xml'),
      get(f, 'https://plugins.gradle.org/m2/xyz/jpenilla/run-paper/xyz.jpenilla.run-paper.gradle.plugin/maven-metadata.xml'),
    ]);
    const runPaper = /<release>([^<]+)<\/release>/.exec(rpXml)?.[1]; if (!runPaper) throw new Error('run-paper release not found');
    const api = mavenVersions(apiXml);
    const versions: ResolvedVersion[] = [];
    for (const { version: v } of vs.versions) {
      if (versions.length >= max) break;
      if (!/^\d+\.\d+(\.\d+)?$/.test(v.id) || cmpMc(v.id, '1.20.6') < 0) continue; // releases only; 1.20.6+ (Java 21+)
      // 26.x publishes `26.3.build.N-stable`; 1.x publishes `1.21.11-R0.1-SNAPSHOT`.
      const dep = api.filter((a) => a.startsWith(`${v.id}.build.`) && a.endsWith('-stable')).sort((a, b) => Number(/build\.(\d+)/.exec(a)![1]) - Number(/build\.(\d+)/.exec(b)![1])).pop()
        ?? api.find((a) => a === `${v.id}-R0.1-SNAPSHOT`);
      if (!dep) continue;
      versions.push({ minecraft: v.id, javaMajor: v.java?.version?.minimum ?? 21, deps: { paperApiVersion: dep, apiVersion: v.id } });
    }
    if (!versions.length) throw new Error('no Paper release with a paper-api artifact found');
    return { resolver: 'paper', source: 'live', errors: [], note: `Live: PaperMC Fill API, PaperMC maven, Gradle Plugin Portal (run-paper ${runPaper}) — fetched ${new Date().toISOString()}`, shared: { runPaperVersion: runPaper }, versions };
  } catch (e) {
    return { ...PAPER_FALLBACK, errors: [e instanceof Error ? e.message : String(e)] };
  }
}

export function resolveFor(resolver: string, f: Fetch): Promise<Resolution> {
  if (resolver === 'fabric') return resolveFabric(f);
  if (resolver === 'paper') return resolvePaper(f);
  return Promise.resolve({ resolver, source: 'live', note: 'No versions needed', versions: [], shared: {}, errors: [] });
}
