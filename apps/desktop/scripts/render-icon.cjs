// Renders resources/icon.svg -> build/icon.png (512x512) using Electron offscreen. Run: electron scripts/render-icon.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'); const path = require('node:path');
app.whenReady().then(async () => { try {
  const svg = fs.readFileSync(path.join(__dirname, '../resources/icon.svg'), 'utf8');
  const w = new BrowserWindow({ width: 512, height: 512, show: true, frame: false, useContentSize: true });
  await w.loadURL('data:text/html,' + encodeURIComponent(`<body style="margin:0;background:#0B0F1E">${svg.replace('<svg ', '<svg width="512" height="512" ')}</body>`));
  await new Promise((r) => setTimeout(r, 500));
  const img = await w.webContents.capturePage({ x: 0, y: 0, width: 512, height: 512 });
  fs.writeFileSync(path.join(__dirname, '../build/icon.png'), img.resize({ width: 512, height: 512 }).toPNG());
  } catch (e) { console.error(e); process.exitCode = 1; } app.quit();
});
