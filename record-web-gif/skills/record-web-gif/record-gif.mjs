#!/usr/bin/env node
// Record a running web app to a GIF: drive Chrome with puppeteer-core (system Chrome, no
// chromium download), capture frames over CDP, assemble with ffmpeg (2-pass palette).
//
// Usage:
//   node record-gif.mjs <url> <out.gif> [options]
//
// Options (all optional):
//   --fps N            target capture frames/sec        (default 15)
//   --duration MS      record length in ms              (default 12000)
//   --size WxH         capture viewport                 (default 1000x630)
//   --scale W          GIF width in px (height auto)     (default = capture width)
//   --headless         run headless (see WebGL note)    (default: headful = GPU = smoother)
//   --wait-text "T"    wait for an enabled <button> whose text === T before starting
//   --start-text "T"   click the <button> whose text === T to begin (e.g. "Start"/"Play")
//   --hide "SEL"       CSS selector to hide while recording (repeatable)
//   --settle MS        pause after load before starting  (default 1500; lets tiles/fonts settle)
//   --chrome PATH      Chrome/Chromium executable        (default: auto-detect, or $CHROME_PATH)
//   --keep-frames      don't delete the temp frame dir
//
// WebGL/canvas apps (MapLibre, three.js, charts): prefer headful — software WebGL in headless
// is slow and recent Chrome blocks it unless you pass --enable-unsafe-swiftshader (this script
// adds that flag automatically in headless mode so the app doesn't crash, but headful is smoother).
//
// Requires: ffmpeg on PATH, and `npm i puppeteer-core` available to this script.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const pos = [];
const opt = { hide: [] };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--headless') opt.headless = true;
  else if (a === '--keep-frames') opt.keepFrames = true;
  else if (a === '--hide') opt.hide.push(argv[++i]);
  else if (a.startsWith('--')) opt[a.slice(2)] = argv[++i];
  else pos.push(a);
}
const url = pos[0];
const outGif = pos[1];
if (!url || !outGif) {
  console.error('usage: node record-gif.mjs <url> <out.gif> [options] (see header)');
  process.exit(2);
}

const [W, H] = (opt.size || '1000x630').split('x').map(Number);
const FPS = Number(opt.fps || 15);
const DURATION_MS = Number(opt.duration || 12000);
const SCALE = Number(opt.scale || W);
const SETTLE = Number(opt.settle ?? 1500);
const HEADLESS = !!opt.headless;

const CHROME = opt.chrome || process.env.CHROME_PATH || [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].find((p) => existsSync(p));
if (!CHROME) { console.error('No Chrome found — pass --chrome PATH or set CHROME_PATH'); process.exit(2); }

const { default: puppeteer } = await import('puppeteer-core');

const frameDir = mkdtempSync(join(tmpdir(), 'recgif-'));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: HEADLESS,
  args: [
    '--no-sandbox', '--hide-scrollbars', '--mute-audio', `--window-size=${W},${H}`,
    // Headless software WebGL: required by recent Chrome or the GL context fails and canvas/WebGL apps crash.
    ...(HEADLESS ? ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] : []),
  ],
  defaultViewport: { width: W, height: H, deviceScaleFactor: 1 },
});

try {
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

  if (opt['wait-text']) {
    await page.waitForFunction(
      (t) => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === t); return b && !b.disabled; },
      { timeout: 30000 }, opt['wait-text'],
    );
  }
  if (SETTLE > 0) await new Promise((r) => setTimeout(r, SETTLE));
  for (const sel of opt.hide) await page.addStyleTag({ content: `${sel}{display:none!important}` });

  const client = await page.target().createCDPSession();
  if (opt['start-text']) {
    await page.evaluate((t) => { [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === t)?.click(); }, opt['start-text']);
  }

  const interval = 1000 / FPS;
  const start = Date.now();
  let i = 0;
  while (Date.now() - start < DURATION_MS) {
    const t = Date.now();
    const { data } = await client.send('Page.captureScreenshot', { format: 'jpeg', quality: 90 });
    writeFileSync(join(frameDir, `f_${String(i).padStart(5, '0')}.jpg`), Buffer.from(data, 'base64'));
    i++;
    const wait = interval - (Date.now() - t);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
  const realFps = (i / ((Date.now() - start) / 1000)).toFixed(1);
  console.log(`captured ${i} frames (~${realFps} fps effective)`);

  await browser.close();

  // Assemble with a 2-pass palette for clean GIF colors. Use the *effective* fps so playback is real-time.
  const pal = join(frameDir, 'palette.png');
  const vf = `scale=${SCALE}:-1:flags=lanczos`;
  const run = (args) => {
    const r = spawnSync('ffmpeg', args, { stdio: ['ignore', 'ignore', 'inherit'] });
    if (r.status !== 0) { console.error('ffmpeg failed'); process.exit(1); }
  };
  run(['-y', '-framerate', realFps, '-i', join(frameDir, 'f_%05d.jpg'), '-vf', `${vf},palettegen=stats_mode=diff`, pal]);
  run(['-y', '-framerate', realFps, '-i', join(frameDir, 'f_%05d.jpg'), '-i', pal, '-lavfi', `${vf} [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=3`, outGif]);
  console.log(`wrote ${outGif}`);
} finally {
  if (!opt.keepFrames) rmSync(frameDir, { recursive: true, force: true });
  else console.log(`frames kept in ${frameDir}`);
  if (browser.connected) await browser.close().catch(() => {});
}
