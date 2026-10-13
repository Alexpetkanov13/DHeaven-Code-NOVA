const { greet } = require('./greeter');

describe('greet', () => {
  it('greets by name', () => {
    expect(greet('NOVA')).toBe('Hello, NOVA!');
  });

  describe('punctuation', () => {
    test('uses a custom mark', () => {
      expect(greet('NOVA', '?')).toBe('Hello, NOVA?');
    });
    test('deliberate failure', () => {
      if (process.env.NOVA_DEMO_FAIL !== '1') return; // set NOVA_DEMO_FAIL=1 to see a failure
      expect(greet('NOVA', '?')).toBe('Hello, NOVA!');
    });
  });

  it.todo('not implemented yet');
});
