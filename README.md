# Dawzer

A simple recording app — record takes over a metronome, add multiple audio tracks,
pick your audio input/output, and export takes to WAV or MP3.
Built with Electron so the same code runs on your Mac (for testing) and on Windows.

## What it does

- **Metronome** with adjustable tempo (BPM), beats-per-bar, and click volume.
- **Count-in** (none / 1 bar / 2 bars) before recording starts.
- **Record multiple takes** from a chosen input device. Each take is kept in a list.
- **Backing track**: load an audio file and play it while you record.
- **Simple mixing**: play a take back on its own or layered over the backing track,
  with separate volume sliders for the backing track and take playback.
- **Audio setup**: choose which input (mic/interface) to record from and which output
  (speakers/headphones) to listen through. Optional input monitoring.
- **Export** any take to **WAV** (lossless) or **MP3** (192 kbps).

## Requirements

- [Node.js](https://nodejs.org) 18 or newer (includes `npm`).

## Run it (Mac or Windows)

From a terminal, inside this folder:

```bash
npm install
npm start
```

`npm install` pulls in Electron (first run downloads ~100 MB, one time).
`npm start` launches the app.

### First launch
1. Click **⚙️ Audio Setup** at the top right.
2. Grant microphone permission when the OS asks (needed so device names show up).
   - **macOS**: System Settings → Privacy & Security → Microphone → enable your terminal/the app.
3. Pick your **Input** (what to record from) and **Output** (what to listen through).
4. If you want to hear yourself while recording, tick **Monitor input** — use headphones
   so the mic doesn't pick up the output.

### Recording a take
1. Set the tempo and beats-per-bar.
2. (Optional) Load a backing track and make sure "Play backing track while recording" is ticked.
3. Hit **● Record take**. You'll hear the count-in, then recording starts on the downbeat.
4. Hit **■ Stop** when done. The take appears in the **Takes** list.
5. Use **▶ Play**, **▶ + Backing**, **WAV**, or **MP3** on each take.

## Build a Windows installer

You can build the Windows `.exe` installer from **either** OS, but building *on Windows*
is the most reliable.

**On Windows:**
```bash
npm install
npm run dist:win
```
The installer appears in the `dist/` folder as `Dawzer-Setup-1.0.0.exe`.
Copy that to your dad's PC and run it — no Node or terminal needed on his machine.

**On Mac (cross-building for Windows):** `npm run dist:win` can work but sometimes needs
extra tooling (Wine) for the installer step. If it gives you trouble, build on a Windows
machine or a Windows VM. To build a Mac app for local testing: `npm run dist:mac`.

## Notes

- The app turns **off** echo cancellation / noise suppression / auto-gain so your
  instrument or voice is captured raw and unprocessed.
- Output-device switching uses `AudioContext.setSinkId`, supported in the Electron/Chromium
  build this app ships with.
- No internet connection is used or required at runtime.
- The MP3 encoder is `lamejs` (`lamejs.min.js`, MIT — see `LAMEJS-LICENSE`), vendored so no
  extra runtime dependency is needed.

## Project layout

| File            | Purpose                                             |
|-----------------|-----------------------------------------------------|
| `main.js`       | Electron main process (window + file save/open).    |
| `index.html`    | UI layout.                                           |
| `styles.css`    | Styling.                                             |
| `renderer.js`   | All audio logic: metronome, recording, mixing, export. |
| `lamejs.min.js` | Vendored MP3 encoder.                                |
| `package.json`  | Scripts and build config.                            |
# dawzer
