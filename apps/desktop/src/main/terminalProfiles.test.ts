import { describe, expect, it } from 'vitest';
import { detectProfiles, pickProfile } from './terminalProfiles';

describe('terminal profiles', () => {
  it('windows: PowerShell, cmd and Git Bash when present (pwsh only if on PATH)', () => {
    const have = new Set(['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', 'C:\\Windows\\System32\\cmd.exe', 'C:\\Program Files\\Git\\bin\\bash.exe']);
    const ps = detectProfiles('win32', { SystemRoot: 'C:\\Windows', ComSpec: 'C:\\Windows\\System32\\cmd.exe', ProgramFiles: 'C:\\Program Files', PATH: '' }, (p) => have.has(p));
    expect(ps.map((p) => p.id)).toEqual(['powershell', 'cmd', 'bash']);
    expect(ps[2]!.path).toBe('C:\\Program Files\\Git\\bin\\bash.exe');
  });
  it('unix: $SHELL first, no duplicates', () => {
    const ps = detectProfiles('linux', { SHELL: '/bin/bash' }, (p) => ['/bin/bash', '/bin/sh'].includes(p));
    expect(ps.map((p) => p.id)).toEqual(['bash', 'sh']);
  });
  it('pick: requested > saved > default; unknown ids fall through', () => {
    const ps = [{ id: 'bash', name: 'bash', path: '/bin/bash' }, { id: 'sh', name: 'sh', path: '/bin/sh' }];
    expect(pickProfile(ps, 'sh', 'bash')!.id).toBe('sh');
    expect(pickProfile(ps, 'nope', 'sh')!.id).toBe('sh');
    expect(pickProfile(ps, null, 'nope')!.id).toBe('bash');
    expect(pickProfile([], 'x')).toBeNull();
  });
});
