---
name: record-web-gif
description: Use when you need a GIF or screen recording of a running web app — a local dev server or a live URL — for a README, PR, or demo, including UI animations, canvas, charts, WebGL, or MapLibre map apps that render blank under naive headless capture.
---

# Record a Web App to a GIF

Drive Chrome with `puppeteer-core` (your **system** Chrome — no chromium download), capture
frames over CDP, and assemble a clean GIF with ffmpeg. One bundled script does all of it.

## Prerequisites

- `ffmpeg` on PATH (`brew install ffmpeg`).
- `puppeteer-core` resolvable from where you run the script: `npm i puppeteer-core` in a scratch
  dir and run the script from there (it uses your installed Chrome, so no large download).
- Google Chrome (or Chromium) installed. Override with `--chrome PATH` or `$CHROME_PATH`.

## Quick start

Record a 12s clip and write the GIF in one command:

```bash
node record-gif.mjs "http://localhost:5173/" out.gif \
  --duration 12000 --fps 15 --size 1000x630 --scale 800
```

For an app where you press a button to start an animation, and you want the UI chrome out of
the frame:

```bash
node record-gif.mjs "http://localhost:5173/?demo=1" out.gif \
  --wait-text Start --start-text Start --hide ".controls" \
  --duration 31000 --fps 15
```

## Options

| Flag | Purpose | Default |
|------|---------|---------|
| `--duration MS` | clip length | 12000 |
| `--fps N` | target capture rate | 15 |
| `--size WxH` | capture viewport | 1000x630 |
| `--scale W` | GIF width (height auto) — shrink for size | = capture width |
| `--headless` | run headless (see WebGL note) | off (headful) |
| `--wait-text "T"` | wait for an enabled `<button>` with this text before starting | — |
| `--start-text "T"` | click the `<button>` with this text to begin | — |
| `--hide "SEL"` | CSS selector to hide while recording (repeatable) | — |
| `--settle MS` | pause after load (lets tiles/fonts settle) | 1500 |
| `--chrome PATH` | Chrome/Chromium executable | auto-detect |
| `--keep-frames` | keep the temp frame dir | off |

The GIF is assembled with a **2-pass palette** (`palettegen`/`paletteuse`) at the *effective*
capture rate, so playback is real-time with clean colors.

## WebGL / canvas apps (MapLibre, three.js, charts) — read this

Naive headless capture of a WebGL or `<canvas>` app often yields a **blank** frame or a crashed
page: recent Chrome can't create a software WebGL context (`Could not create a WebGL context …
BindToCurrentSequence failed`), MapLibre throws, and React unmounts. Two facts:

- **Headless needs `--enable-unsafe-swiftshader`** (plus `--use-angle=swiftshader`). This script
  adds those automatically in `--headless` mode so the app renders — but software WebGL is **slow
  to capture (~6 fps)**, so pans look choppy.
- **Headful (the default here) uses the GPU** and captures smoothly (~12–15 fps). It opens a
  visible Chrome window for the duration. Prefer it for anything with camera motion.

## Common mistakes

- **Blank/dark GIF of a map or canvas app** → you ran headless without the swiftshader flags, or
  the app crashed. Use headful (default), or confirm `webgl` works (the script's flags handle it).
- **Choppy motion** → software WebGL headless caps at ~6 fps. Re-record headful.
- **GIF too big for a README** → lower `--scale` (e.g. 720), drop `--fps` to 12, or trim
  `--duration`. Dark/flat UIs compress well; ~5–8 MB at 800px/15fps for ~30s is typical.
- **Animation never plays / controls in frame** → use `--start-text` to trigger it and `--hide`
  to drop the UI chrome (Start/Replay buttons, panels) for a clean recording.
- **`Cannot find package 'puppeteer-core'`** → run the script from a dir where it's installed
  (bare ESM imports resolve from the script's location upward, not from `$NODE_PATH`).

## Why this approach

`puppeteer-core` + system Chrome avoids a 150 MB chromium download and matches the browser the
app is actually tested in. CDP `Page.captureScreenshot` in a fixed-interval loop gives predictable
frame timing; ffmpeg's two-pass palette beats a naive single-pass GIF on banding. The script is
in this folder: [record-gif.mjs](record-gif.mjs).
