import { describe, expect, it } from 'vitest';
import { sanitizeTheme } from './themeSanitize';

describe('sanitizeTheme', () => {
  it('keeps hex colours on allowlisted variables and drops everything else', () => {
    const s = sanitizeTheme({
      colors: { 'editor.background': '#112233', 'editor.foreground': 'red', 'bad key!': '#000000' },
      tokenColors: [{ token: 'keyword', foreground: '#FF00AA', fontStyle: 'italic bold' }, { token: 'x', foreground: 'url(evil)', fontStyle: 'expression()' }, { token: '<script>' }],
      workbench: { 'nova-cyan': '#FF9E64', 'nova-text': 'rgb(1,2,3)', 'font-family': '#000000', 'nova-border': '#000;background:url(x)' },
    }, 'dark');
    expect(s.colors).toEqual({ 'editor.background': '#112233' });
    expect(s.rules).toEqual([{ token: 'keyword', foreground: 'FF00AA', fontStyle: 'italic bold' }, { token: 'x' }]);
    expect(s.vars).toEqual({ 'nova-cyan': '#FF9E64' });
    expect(s.dropped).toBe(6);
    expect(s.base).toBe('vs-dark');
    expect(sanitizeTheme(null, 'light').base).toBe('vs');
  });
});
