import { describe, expect, it } from 'vitest';
import { DEBUG_LISTEN_RE, parseJUnitXml, scanTestSource, testArgs } from './junit';

describe('junit', () => {
  it('scans JUnit 5 sources', () => {
    const r = scanTestSource(`package a.b;\nimport org.junit.jupiter.api.Test;\n/** class Doc */\nclass FooTest {\n  @Test\n  void one() {}\n  @Test @Disabled\n  public void two() { if (x) { } }\n  void helper() {}\n  @ParameterizedTest\n  @ValueSource(ints = {1})\n  void three(int i) {}\n}\n`);
    expect(r.pkg).toBe('a.b');
    expect(r.classes).toEqual([{ name: 'FooTest', line: 4, methods: [{ name: 'one', line: 6 }, { name: 'two', line: 8 }, { name: 'three', line: 12 }] }]);
  });
  it('parses JUnit XML incl. failure, skipped, stdout, entities', () => {
    const xml = `<?xml version="1.0"?><testsuite name="a.T" tests="3"><testcase name="ok()" classname="a.T" time="0.012"><system-out><![CDATA[hi <there>]]></system-out></testcase>
<testcase name="bad()" classname="a.T" time="0.5"><failure message="expected: &lt;1&gt;" type="AFE">AFE: expected
\tat a.T.bad(T.java:9)</failure></testcase><testcase name="skip()" classname="a.T" time="0"><skipped/></testcase><testcase name="err()" classname="a.T" time="0"><error message="NPE" type="java.lang.NullPointerException"/></testcase></testsuite>`;
    const r = parseJUnitXml(xml);
    expect(r.map((t) => [t.id, t.status, t.timeMs])).toEqual([['a.T.ok', 'passed', 12], ['a.T.bad', 'failed', 500], ['a.T.skip', 'skipped', 0], ['a.T.err', 'error', 0]]);
    expect(r[0]!.stdout).toBe('hi <there>');
    expect(r[1]!.message).toBe('expected: <1>');
    expect(r[1]!.stack).toContain('T.java:9');
  });
  it('builds gradle args and detects the debug port', () => {
    expect(testArgs(['a.T.bad'], true)).toEqual(['test', '--tests', 'a.T.bad', '--rerun', '--debug-jvm']);
    expect(DEBUG_LISTEN_RE.exec('Listening for transport dt_socket at address: 5005')![1]).toBe('5005');
  });
  it('falls back to class-level system-out (Gradle default)', () => {
    const r = parseJUnitXml('<testsuite><testcase name="a()" classname="T" time="0"/><testcase name="b()" classname="T" time="0"></testcase><system-out><![CDATA[checking prefix\n]]></system-out><system-err><![CDATA[]]></system-err></testsuite>');
    expect(r[0]!.stdout).toContain('checking prefix');
    expect(r[1]!.stdout).toContain('class-level');
  });
});
