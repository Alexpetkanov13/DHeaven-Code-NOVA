import { describe, expect, it, test } from 'vitest';
import { greet } from './greeter';

describe('greet', () => {
  it('greets by name', () => {
    console.log('greeting NOVA');
    expect(greet('NOVA')).toBe('Hello, NOVA!');
  });

  describe('punctuation', () => {
    it('uses a custom mark', () => {
      expect(greet('NOVA', '?')).toBe('Hello, NOVA?');
    });
    it('deliberate failure', () => {
      if (process.env.NOVA_DEMO_FAIL !== '1') return; // set NOVA_DEMO_FAIL=1 to see a failure
      expect(greet('NOVA', '?')).toBe('Hello, NOVA!');
    });
  });

  it.skip('not implemented yet', () => {});
});

test('top level & "quoted" name', () => {
  expect(greet('A')).toContain('A');
});
