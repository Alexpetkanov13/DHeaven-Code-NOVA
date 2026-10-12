import { describe, expect, it } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { checkCapability, packFiles, readArchive, safeEntryPath, satisfies, validateManifest, INTEGRITY_FILE, sha256 } from './index';

const base = {
  manifestVersion: 1, name: 'hello', publisher: 'dheaven', displayName: 'Hello', version: '1.0.0', engines: { nova: '^0.1.0' }, main: 'extension.js',
  activationEvents: ['onCommand:hello.say'], contributes: { commands: [{ command: 'hello.say', title: 'Say Hello' }] },
};
const enc = (s: string) => strToU8(s);
const files = (m: object = base, extra: Record<string, string> = {}) => new Map<string, Uint8Array>([['nova-extension.json', enc(JSON.stringify(m))], ['extension.js', enc('exports.activate=()=>{}')], ...Object.entries(extra).map(([k, v]) => [k, enc(v)] as [string, Uint8Array])]);

describe('semver', () => {
  it('ranges', () => {
    expect(satisfies('0.1.5', '^0.1.0')).toBe(true);
    expect(satisfies('0.2.0', '^0.1.0')).toBe(false);
    expect(satisfies('1.4.0', '^1.2.3')).toBe(true);
    expect(satisfies('2.0.0', '^1.2.3')).toBe(false);
    expect(satisfies('1.2.9', '~1.2.0')).toBe(true);
    expect(satisfies('1.3.0', '~1.2.0')).toBe(false);
    expect(satisfies('0.1.0', '>=0.1.0 <1.0.0')).toBe(true);
    expect(satisfies('0.1.0-beta', '^0.1.0')).toBe(false);
  });
});

describe('manifest', () => {
  it('accepts a valid manifest and fills defaults', () => {
    const r = validateManifest(base, '0.1.0');
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.manifest.permissions).toEqual([]); expect(r.manifest.contributes.themes).toEqual([]); }
  });
  it('rejects bad ids, unknown fields, unknown permissions, engine mismatch, dangling references', () => {
    const bad = (m: object, v?: string) => { const r = validateManifest(m, v); return r.ok ? [] : r.errors.join('\n'); };
    expect(bad({ ...base, name: 'Hello World' })).toMatch(/name/);
    expect(bad({ ...base, evil: true })).toMatch(/Unrecognized key/i);
    expect(bad({ ...base, permissions: ['root'] })).toMatch(/permissions/);
    expect(bad({ ...base }, '0.2.0')).toMatch(/requires NOVA \^0.1.0/);
    expect(bad({ ...base, activationEvents: ['onCommand:nope'] })).toMatch(/undeclared command/);
    expect(bad({ ...base, main: '../escape.js' })).toMatch(/relative path/);
    expect(bad({ ...base, main: undefined })).toMatch(/main: required/);
    expect(bad({ ...base, activationEvents: ['onFileSystem:x'] })).toMatch(/unsupported activation/);
    expect(bad({ ...base, contributes: { ...base.contributes, menus: { commandPalette: [{ command: 'other' }] } } })).toMatch(/not declared/);
  });
});

describe('Minecraft-pack contribution points', () => {
  it('validates projectTemplates / jsonValidation / yamlValidation / gradleRunTasks', () => {
    const base = { manifestVersion: 1, name: 'mc', publisher: 'p', displayName: 'MC', version: '1.0.0', engines: { nova: '*' } };
    const ok = validateManifest({ ...base, contributes: {
      projectTemplates: [{ id: 't', label: 'T', path: 'templates/t', resolver: 'paper' }],
      jsonValidation: [{ fileMatch: ['assets/*/models/**/*.json'], schema: 's.json' }], yamlValidation: [{ fileMatch: ['plugin.yml'], schema: 'p.json' }],
      gradleRunTasks: [{ view: 'Minecraft', plugin: 'xyz.jpenilla.run-paper', label: 'Paper', tasks: [{ name: 'runServer', label: 'Run', requiresEula: true }] }],
    } });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.manifest.contributes.gradleRunTasks[0]!.tasks[0]!.runDir).toBe('run');
    const bad = validateManifest({ ...base, contributes: { projectTemplates: [{ id: 't', label: 'T', path: '../x', resolver: 'curl' }], jsonValidation: [{ fileMatch: ['../../etc/*'], schema: '/abs.json' }], gradleRunTasks: [{ view: 'V', plugin: 'p', label: 'L', tasks: [{ name: 'run; rm -rf /', label: 'x', runDir: '../..' }] }] } });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.join('\n')).toMatch(/projectTemplates[\s\S]*jsonValidation[\s\S]*gradleRunTasks/);
  });
});

describe('permissions', () => {
  it('UI APIs need nothing; gated APIs need declaration and a grant', () => {
    expect(checkCapability('output.append', [], {})).toEqual({ allow: true });
    expect(checkCapability('workspace.readFile', [], {})).toMatchObject({ allow: false, reason: expect.stringMatching(/not declared/) });
    expect(checkCapability('workspace.readFile', ['workspace.read'], {})).toEqual({ ask: 'workspace.read' });
    expect(checkCapability('workspace.readFile', ['workspace.read'], { 'workspace.read': 'granted' })).toEqual({ allow: true });
    expect(checkCapability('net.fetch', ['network'], { network: 'denied' })).toMatchObject({ allow: false, reason: expect.stringMatching(/denied/) });
    expect(checkCapability('fs.rm', ['workspace.write'], {})).toMatchObject({ allow: false });
  });
});

describe('archives (zip-slip, integrity)', () => {
  it('rejects hostile entry names', () => {
    for (const n of ['../x', 'a/../../x', '/etc/passwd', 'C:/x', 'a\\b', 'a\0b', '//server/x', 'con.txt', 'x/aux', 'a. ']) expect(() => safeEntryPath(n)).toThrow();
    expect(safeEntryPath('./a/b.js')).toBe('a/b.js');
  });
  it('round-trips pack -> read with integrity', () => {
    const { data, sha256: h } = packFiles(files());
    const r = readArchive(data, '0.1.0');
    expect(r.archiveSha256).toBe(h);
    expect(r.manifest.name).toBe('hello');
    expect([...r.files.keys()].sort()).toEqual(['.nova/integrity.json', 'extension.js', 'nova-extension.json']);
  });
  it('rejects zip-slip entries inside an archive', () => {
    const z = zipSync({ 'nova-extension.json': enc(JSON.stringify(base)), '../../evil.js': enc('x') });
    expect(() => readArchive(z)).toThrow(/path traversal/);
    const z2 = zipSync({ '/abs.js': enc('x') });
    expect(() => readArchive(z2)).toThrow(/absolute|empty/);
  });
  it('rejects tampered content, unlisted files, missing integrity, case collisions, size bombs', () => {
    const m = enc(JSON.stringify(base)); const js = enc('exports.activate=()=>{}');
    const integ = (f: Record<string, Uint8Array>) => enc(JSON.stringify({ algorithm: 'sha256', files: Object.fromEntries(Object.entries(f).map(([k, v]) => [k, sha256(v)])) }));
    expect(() => readArchive(zipSync({ 'nova-extension.json': m, 'extension.js': js }))).toThrow(/missing .nova\/integrity.json/);
    expect(() => readArchive(zipSync({ 'nova-extension.json': m, 'extension.js': enc('tampered'), [INTEGRITY_FILE]: integ({ 'nova-extension.json': m, 'extension.js': js }) }))).toThrow(/SHA-256 mismatch for extension.js/);
    expect(() => readArchive(zipSync({ 'nova-extension.json': m, 'extension.js': js, 'extra.js': js, [INTEGRITY_FILE]: integ({ 'nova-extension.json': m, 'extension.js': js }) }))).toThrow(/not listed: extra.js/);
    expect(() => readArchive(zipSync({ 'nova-extension.json': m, 'A.js': js, 'a.js': js }))).toThrow(/duplicate/);
    const big = new Uint8Array(3 * 1024 * 1024);
    expect(() => readArchive(zipSync({ 'nova-extension.json': m, 'big.bin': big }), undefined, { maxEntries: 10, maxFileBytes: 1024 * 1024, maxTotalBytes: 2 * 1024 * 1024, maxArchiveBytes: 1e9 })).toThrow(/too large/);
  });
  it('pack refuses manifests referencing missing files', () => {
    expect(() => packFiles(new Map([['nova-extension.json', enc(JSON.stringify(base))]]))).toThrow(/missing files: extension.js/);
  });
});
