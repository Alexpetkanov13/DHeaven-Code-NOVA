import path from 'node:path';
import fs from 'node:fs';
import { DapConnection } from './connection';
import type { AdapterFactory, LaunchConfig } from './manager';
import type { Jdk } from '../jdk';

/** microsoft/java-debug, loaded into JDT LS as an OSGi bundle. Pinned + verified like the language servers. */
export const JAVA_DEBUG = {
  id: 'java-debug', name: 'Java Debug Server (microsoft/java-debug)', version: '0.53.1', languages: [] as string[], minJava: 21,
  download: { url: 'https://repo1.maven.org/maven2/com/microsoft/java/com.microsoft.java.debug.plugin/0.53.1/com.microsoft.java.debug.plugin-0.53.1.jar', sha256: '4f4778d452a6a0665536f43ce4e32403a24be6593336b80dc85a322912859e24', kind: 'jar' as const, sizeHint: '~3 MB', license: 'EPL-1.0' },
  installDir: (d: string) => path.join(d, 'java-debug', '0.53.1'),
  jar: (d: string) => path.join(d, 'java-debug', '0.53.1', 'com.microsoft.java.debug.plugin-0.53.1.jar'),
  isInstalledSync: (d: string) => fs.existsSync(path.join(d, 'java-debug', '0.53.1', 'com.microsoft.java.debug.plugin-0.53.1.jar')),
};

export interface JavaDeps {
  /** workspace/executeCommand on the ready JDT LS (throws if not ready or debug bundle missing). */
  exec(command: string, args: unknown[], timeoutMs?: number): Promise<unknown>;
  waitJdtReady(timeoutMs: number, signal: AbortSignal): Promise<void>;
  jdkFor(cfg: LaunchConfig): Promise<Jdk | null>;
  debugInstalled(): boolean;
}

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((r) => { const t = setTimeout(r, ms); signal.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true }); });

export function javaAdapter(d: JavaDeps): AdapterFactory {
  return async (cfg, { root, log, signal }) => {
    if (!d.debugInstalled()) throw new Error('Java Debug Server is not installed. Install it from the Run and Debug view.');
    log('Waiting for Eclipse JDT Language Server…');
    await d.waitJdtReady(300_000, signal);
    let mainClass = cfg.mainClass?.trim() || '';
    let projectName = cfg.projectName?.trim() || '';
    // Project import/build happens asynchronously in JDT LS; retry resolution while it settles.
    const deadline = Date.now() + 240_000;
    let lastErr: unknown = null;
    if (cfg.request === 'launch') {
      for (;;) {
        if (signal.aborted) throw new Error('Cancelled');
        try {
          const mains = ((await d.exec('vscode.java.resolveMainClass', [root], 60_000)) ?? []) as { mainClass: string; projectName: string; filePath: string }[];
          const hit = mainClass ? mains.find((m) => m.mainClass === mainClass) : mains[0];
          if (hit) { mainClass = hit.mainClass; projectName ||= hit.projectName; break; }
          lastErr = new Error(mainClass ? `Main class ${mainClass} not found in the workspace` : 'No main class found in the workspace');
        } catch (e) { lastErr = e; }
        if (Date.now() > deadline) throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
        await sleep(2000, signal);
      }
      log(`Main class: ${mainClass} (project ${projectName || '?'})`);
    }
    const jdk = await d.jdkFor(cfg);
    if (!jdk) throw new Error('No JDK found for the debuggee; select one in the launch configuration.');
    let args: Record<string, unknown>;
    if (cfg.request === 'launch') {
      const [modulePaths, classPaths] = (await d.exec('vscode.java.resolveClasspath', [mainClass, projectName], 120_000)) as [string[], string[]];
      args = {
        type: 'java', name: cfg.name, request: 'launch', mainClass, projectName, args: cfg.args ?? '', vmArgs: cfg.vmArgs ?? '',
        cwd: cfg.cwd ? path.resolve(root, cfg.cwd) : root, env: cfg.env ?? {}, modulePaths, classPaths,
        javaExec: path.join(jdk.home, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'),
        console: 'internalConsole', stopOnEntry: false, shortenCommandLine: 'auto', encoding: 'UTF-8',
      };
    } else {
      args = { type: 'java', name: cfg.name, request: 'attach', hostName: cfg.hostName || 'localhost', port: cfg.port ?? 5005, projectName: projectName || undefined, timeout: 30_000 };
    }
    const port = Number(await d.exec('vscode.java.startDebugSession', [], 30_000));
    if (!Number.isInteger(port) || port <= 0) throw new Error(`java-debug returned no port (${port}); is the debug bundle loaded?`);
    log(`Connecting to java-debug on 127.0.0.1:${port}`);
    const sock = await DapConnection.connect(port);
    return { conn: new DapConnection(sock, (command) => { throw new Error(`reverse request ${command} not supported`); }), args };
  };
}
