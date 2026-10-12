import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { fileMatches, validateSchema } from './schemaValidate';

const EXT = path.resolve(__dirname, '../../../../../extensions/bundled/minecraft-dev');
const schema = (n: string) => JSON.parse(fs.readFileSync(path.join(EXT, 'schemas', n), 'utf8'));
const tpl = (rel: string) => fs.readFileSync(path.join(EXT, 'templates', rel), 'utf8').replace(/\{\{(\w+)\}\}/g, (_m, k: string) => ({ modId: 'testmod', javaVersion: '25', minecraftVersion: '26.3', loaderVersion: '0.19.5', package: 'com.example.t', className: 'TestMod', apiVersion: '26.3' } as Record<string, string>)[k] ?? 'x');

describe('Minecraft schemas (CSP-safe validator)', () => {
  it('fabric.mod.json: template output is valid; bad id / wrong types / unknown keys are reported', () => {
    const s = schema('fabric.mod.json.schema.json');
    expect(validateSchema(s, JSON.parse(tpl('fabric-mod/src/main/resources/fabric.mod.json')))).toEqual([]);
    const errs = validateSchema(s, { schemaVersion: 2, id: 'Bad Id', environment: 'both', entrypoints: { main: [42] }, bogus: 1 });
    const msgs = errs.map((e) => `${e.path.join('.')}: ${e.message}`).join('\n');
    expect(msgs).toMatch(/Missing required property "version"/);
    expect(msgs).toMatch(/schemaVersion: Must be 1/);
    expect(msgs).toMatch(/^id: Invalid value/m);
    expect(msgs).toMatch(/environment: Must be one of/);
    expect(msgs).toMatch(/entrypoints\.main\.0:/);
    expect(msgs).toMatch(/bogus: Unknown property/);
  });
  it('plugin.yml: template output is valid; missing main / bad load / bad main are reported', () => {
    const s = schema('plugin.yml.schema.json');
    expect(validateSchema(s, parse(tpl('paper-plugin/src/main/resources/plugin.yml')))).toEqual([]);
    const msgs = validateSchema(s, parse('name: Bad:Name\nversion: 1\nload: LATER\ncommands:\n  hi:\n    usage: /hi\n    colour: red\n')).map((e) => `${e.path.join('.')}: ${e.message}`).join('\n');
    expect(msgs).toMatch(/Missing required property "main"/); expect(msgs).toMatch(/^name: Invalid/m); expect(msgs).toMatch(/load: Must be one of/); expect(msgs).toMatch(/commands\.hi\.colour: Unknown property/);
    expect(validateSchema(s, parse('name: X\nversion: 1\nmain: org.bukkit.Foo'))[0]!.path).toEqual(['main']);
  });
  it('pack.mcmeta and model JSON', () => {
    expect(validateSchema(schema('pack.mcmeta.schema.json'), { pack: { pack_format: 46, description: 'x' } })).toEqual([]);
    expect(validateSchema(schema('pack.mcmeta.schema.json'), { pack: { min_format: [69, 0], max_format: 70, description: { text: 'x' } } })).toEqual([]);
    expect(validateSchema(schema('pack.mcmeta.schema.json'), { pack: { pack_format: 'x' } }).length).toBe(2);
    const m = schema('model.schema.json');
    expect(validateSchema(m, { parent: 'minecraft:block/cube_all', textures: { all: 'mymod:block/x' } })).toEqual([]);
    expect(validateSchema(m, { elements: [{ from: [0, 0, 0], to: [16, 16, 99], faces: { up: { texture: 'side' } } }] }).map((e) => e.path.join('.'))).toEqual(['elements.0.to.2', 'elements.0.faces.up.texture']);
  });
  it('fileMatch globs', () => {
    expect(fileMatches(['plugin.yml'], '/w/src/main/resources/plugin.yml')).toBe(true);
    expect(fileMatches(['plugin.yml'], '/w/notplugin.yml')).toBe(false);
    expect(fileMatches(['assets/*/models/**/*.json'], '/w/src/main/resources/assets/mymod/models/block/a.json')).toBe(true);
    expect(fileMatches(['assets/*/models/**/*.json'], 'assets/mymod/models/a.json')).toBe(true);
    expect(fileMatches(['assets/*/models/**/*.json'], 'assets/mymod/textures/a.json')).toBe(false);
  });
});
