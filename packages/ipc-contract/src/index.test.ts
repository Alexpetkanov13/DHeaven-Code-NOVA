import { describe, expect, it } from 'vitest';
import { channels, isChannel, Settings, SettingsPatch } from './index';

describe('ipc contract', () => {
  it('channel names are versioned', () => {
    for (const name of Object.keys(channels)) expect(name).toMatch(/^[a-z]+\.[a-zA-Z]+\.v\d+$/);
  });
  it('rejects unknown channels and prototype keys', () => {
    expect(isChannel('fs.read.v1')).toBe(true);
    expect(isChannel('fs.exec.v1')).toBe(false);
    expect(isChannel('toString')).toBe(false);
  });
  it('rejects NUL in paths', () => {
    expect(channels['fs.read.v1'].req.safeParse({ rel: 'a\0b' }).success).toBe(false);
  });
  it('settings fill defaults and bound values', () => {
    expect(Settings.parse({}).editorFontSize).toBe(14);
    expect(SettingsPatch.safeParse({ editorFontSize: 400 }).success).toBe(false);
  });
});
