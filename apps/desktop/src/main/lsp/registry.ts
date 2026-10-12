import { JAVA_DEBUG } from '../dap/java';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Jdk } from '../jdk';
import type { LaunchSpec } from './server';

export type ServerId = 'jdtls' | 'kotlin-ls';
export interface ServerDef {
  id: string; name: string; languages: string[]; version: string; minJava: number;
  /** Highest JDK major the server is known to run on (inclusive); undefined = no limit. */
  maxJava?: number;
  download: { url: string; sha256: string; kind: 'tar.gz' | 'zip'; sizeHint: string; license: string };
  installDir(serversDir: string): string;
  isInstalled(serversDir: string): Promise<boolean>;
  launch(o: { serversDir: string; storageDir: string; root: string; jdk: Jdk }): Promise<LaunchSpec>;
  initOptions?(jdk: Jdk, serversDir: string): unknown;
  limitations: string;
}
const exists = (p: string) => fs.access(p).then(() => true, () => false);
const javaExe = (jdk: Jdk) => path.join(jdk.home, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
const hash = (s: string) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);

const JDTLS_VERSION = '1.61.0';
export const SERVERS: Record<ServerId, ServerDef> = {
  jdtls: {
    id: 'jdtls', name: 'Eclipse JDT Language Server', languages: ['java'], version: JDTLS_VERSION, minJava: 21,
    download: { url: `https://download.eclipse.org/jdtls/milestones/${JDTLS_VERSION}/jdt-language-server-${JDTLS_VERSION}-202609031315.tar.gz`, sha256: '338e7e73d61836651ba2453919a0d34fa763eb4e7c03342092309bffb8934c64', kind: 'tar.gz', sizeHint: '~50 MB', license: 'EPL-2.0' },
    installDir: (d) => path.join(d, 'jdtls', JDTLS_VERSION),
    isInstalled: async (d) => exists(path.join(d, 'jdtls', JDTLS_VERSION, 'plugins')),
    async launch({ serversDir, storageDir, root, jdk }) {
      const dir = path.join(serversDir, 'jdtls', JDTLS_VERSION);
      const launcher = (await fs.readdir(path.join(dir, 'plugins'))).find((f) => /^org\.eclipse\.equinox\.launcher_.*\.jar$/.test(f));
      if (!launcher) throw new Error('JDT LS launcher jar not found');
      const os = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux';
      const arm = process.arch === 'arm64' && os !== 'win' ? '_arm' : '';
      // Writable copy of the OSGi configuration per user (install dir may be read-only).
      const cfg = path.join(storageDir, 'jdtls-config', `${os}${arm}`);
      if (!(await exists(path.join(cfg, 'config.ini')))) await fs.cp(path.join(dir, `config_${os}${arm}`), cfg, { recursive: true });
      return {
        command: javaExe(jdk), cwd: root,
        args: ['-Declipse.application=org.eclipse.jdt.ls.core.id1', '-Dosgi.bundles.defaultStartLevel=4', '-Declipse.product=org.eclipse.jdt.ls.core.product',
          '-Dlog.level=WARNING', '-Xms256m', '-Xmx1G', '--add-modules=ALL-SYSTEM', '--add-opens', 'java.base/java.util=ALL-UNNAMED', '--add-opens', 'java.base/java.lang=ALL-UNNAMED',
          '-jar', path.join(dir, 'plugins', launcher), '-configuration', cfg, '-data', path.join(storageDir, 'jdtls-data', hash(root))],
        env: { ...process.env, JAVA_HOME: jdk.home },
      };
    },
    initOptions: (jdk, serversDir) => ({
      // java-debug is an optional OSGi bundle; JDT LS only loads bundles listed here at startup.
      bundles: JAVA_DEBUG.isInstalledSync(serversDir) ? [JAVA_DEBUG.jar(serversDir)] : [],
      settings: { java: {
        configuration: { runtimes: [{ name: `JavaSE-${jdk.major}`, path: jdk.home, default: true }] },
        import: { gradle: { enabled: true, java: { home: jdk.home } } },
        autobuild: { enabled: true }, format: { enabled: true },
      } },
    }),
    limitations: 'Server-initiated workspace/applyEdit is not yet supported, so some code actions that rely on it will report "not applied".',
  },
  'kotlin-ls': {
    id: 'kotlin-ls', name: 'Kotlin Language Server (fwcd)', languages: ['kotlin'], version: '1.3.13', minJava: 11, maxJava: 21,
    download: { url: 'https://github.com/fwcd/kotlin-language-server/releases/download/1.3.13/server.zip', sha256: '4fe7d71d087b307c7869036171bd9d8c6a4284cd7c25b89098b0a24eb2d9b6d2', kind: 'zip', sizeHint: '~90 MB', license: 'MIT' },
    installDir: (d) => path.join(d, 'kotlin-ls'),
    isInstalled: async (d) => exists(path.join(d, 'kotlin-ls', 'server', 'bin', 'kotlin-language-server')),
    async launch({ serversDir, root, jdk, storageDir }) {
      const bin = path.join(serversDir, 'kotlin-ls', 'server', 'bin', 'kotlin-language-server');
      const env = { ...process.env, JAVA_HOME: jdk.home, PATH: path.join(jdk.home, 'bin') + path.delimiter + (process.env.PATH ?? ''), JAVA_OPTS: '-Xmx1G' };
      if (process.platform === 'win32') return { command: 'cmd.exe', args: ['/d', '/s', '/c', bin + '.bat'], cwd: root, env };
      await fs.mkdir(path.join(storageDir, 'kotlin-ls'), { recursive: true });
      return { command: bin, args: [], cwd: root, env };
    },
    limitations: 'fwcd/kotlin-language-server is community-maintained and lags Kotlin 2.x (embeds the Kotlin 2.1.0 compiler) and crashes at startup on JDKs whose version string it cannot parse (e.g. 25.0.4.1), so NOVA runs it on JDK 11–21; Gradle project import is slow and may resolve only part of the classpath. JetBrains kotlin-lsp is currently distributed as a VS Code bundle (.vsix) and is not integrated yet.',
  },
};
export const serverForLanguage = (lang: string): ServerDef | undefined => Object.values(SERVERS).find((s) => s.languages.includes(lang));
