'use strict';

const { ipcRenderer } = require('electron');
// `lamejs` (MP3 encoder) is already a global from lamejs.min.js.

// ===========================================================================
// Config / State
// ===========================================================================
let PPS = 100;
const PPS_MIN = 24, PPS_MAX = 420;
const MIN_DURATION = 20;
const RULER_H = 32, TRACK_H = 118;
const WAVE_H = TRACK_H - 14;
const TRACK_COLORS = ['#9cb080', '#618764', '#7fb0a0', '#c2b56f', '#8bbf8f', '#b58f76', '#7f9ec0'];

const ICON_PLAY = '<svg viewBox="0 0 24 24" class="icn"><polygon points="7,4 20,12 7,20" fill="currentColor" stroke="none"/></svg>';
const ICON_PAUSE = '<svg viewBox="0 0 24 24" class="icn"><rect x="7" y="5" width="3.6" height="14" rx="1.3" fill="currentColor" stroke="none"/><rect x="13.4" y="5" width="3.6" height="14" rx="1.3" fill="currentColor" stroke="none"/></svg>';
const SVG_TRASH = '<svg viewBox="0 0 24 24" class="icn xs"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"/></svg>';

// English tooltip bodies, keyed by the element's data-title. (data-tip holds Bengali.)
const EN_BODY = {
  'Metronome': 'Toggle the click track on or off.',
  'Record': 'Record a clip into the selected track (R). Edit mode overdubs from the playhead.',
  'Edit Mode': 'When on, Record overdubs the clip under the playhead instead of adding a new one.',
  'Play / Pause': 'Play or pause from the playhead. Spacebar also works.',
  'Stop': 'Stop recording or playback and return to the start.',
  'Tempo (BPM)': 'Hold the arrows, or drag the number up and down, to change the tempo.',
  'Beats per Bar': 'How many beats in each bar; beat 1 is accented.',
  'Count-in': 'Metronome bars before recording begins.',
  'Click Volume': 'Metronome click volume.',
  'Timeline': 'Playhead position / total length.',
  'Takes': "Show the selected track's recordings.",
  'Test Output': 'Play a tone through the selected output device.',
  'Add Track': 'Add a new empty track.',
  'Load Track': 'Load an audio file into the selected track.',
  'Audio Setup': 'Choose input & output devices and the language.',
  'Zoom': 'Zoom the timeline: Ctrl + scroll, or pinch on a trackpad.',
  'Audio Clip': 'Drag the middle to move; drag the edges to resize. Right-click for options.',
  'Take': 'Click to jump to this recording on the timeline.',
  'Export WAV': 'Save as a lossless WAV file.',
  'Export MP3': 'Save as a 192 kbps MP3 file.',
  'Delete': 'Delete this recording.',
  'Dawzer': 'A simple recording studio — record takes over a metronome.',
};

const state = {
  ctx: null, inputStream: null,
  inputDeviceId: 'default', outputDeviceId: 'default',
  monitor: false, monitorSource: null, monitorGain: null, tracksGain: null,
  lang: 'en',

  bpm: 100, editMode: false,
  playhead: 0, playing: false, playStartCtx: 0, playStartHead: 0, raf: null,

  metroRunning: false, nextNoteTime: 0, beatCounter: 0, countInLeft: 0, timerId: null, onDownbeat: null,

  recording: false, editing: false, recorder: null, recChunks: [],
  analyser: null, liveBuf: null, livePeaks: [], recStartHead: 0, recStartCtx: 0, recRaf: null, recTrackId: null, recEl: null,

  tracks: [], trackSeq: 0, selectedTrackId: null, playSources: [],
  undoStack: [], redoStack: [],
};
let idCounter = 0;

// ===========================================================================
// Elements
// ===========================================================================
const $ = (id) => document.getElementById(id);
const el = {};
[
  'metroBtn','recordBtn','editBtn','playPauseBtn','stopBtn',
  'bpmUp','bpmDown','bpmValue','beatsPerBar','countIn','clickVol',
  'clock','takesBtn','testBtn','addTrackBtn','loadBackingBtn','settingsBtn',
  'settingsPanel','inputDevice','outputDevice','monitorToggle','backingVol','langSelect','refreshDevices','deviceStatus',
  'labels','trackLabels','addTrackRow','trackLanes','timelineScroll','timeline','rulerCanvas','playhead',
  'takesPanel','tpHeader','tpTrack','tpBody','toast','tooltip','ctxMenu','splash',
].forEach((id) => (el[id] = $(id)));

// ===========================================================================
// Audio context
// ===========================================================================
function ctx() {
  if (!state.ctx) {
    state.ctx = new (window.AudioContext || window.webkitAudioContext)();
    state.tracksGain = state.ctx.createGain();
    state.tracksGain.gain.value = parseFloat(el.backingVol.value);
    state.tracksGain.connect(state.ctx.destination);
  }
  if (state.ctx.state === 'suspended') state.ctx.resume();
  return state.ctx;
}
async function applyOutput() {
  const c = ctx();
  if (typeof c.setSinkId === 'function') {
    try { await c.setSinkId(state.outputDeviceId === 'default' ? '' : state.outputDeviceId); }
    catch (e) { console.warn('setSinkId', e); }
  }
}

// ===========================================================================
// Devices
// ===========================================================================
async function primePermission() {
  try { const s = await navigator.mediaDevices.getUserMedia({ audio: true }); s.getTracks().forEach((t) => t.stop()); }
  catch (e) { el.deviceStatus.textContent = 'Microphone permission denied.'; }
}
async function listDevices() {
  await primePermission();
  const d = await navigator.mediaDevices.enumerateDevices();
  const ins = d.filter((x) => x.kind === 'audioinput'), outs = d.filter((x) => x.kind === 'audiooutput');
  fill(el.inputDevice, ins, state.inputDeviceId);
  fill(el.outputDevice, outs, state.outputDeviceId);
  el.deviceStatus.textContent = `${ins.length} in · ${outs.length} out`;
}
function fill(sel, devices, current) {
  sel.innerHTML = '';
  if (!devices.length) { sel.innerHTML = '<option value="default">System default</option>'; return; }
  devices.forEach((dv, i) => { const o = document.createElement('option'); o.value = dv.deviceId || 'default'; o.textContent = dv.label || `Device ${i + 1}`; sel.appendChild(o); });
  if ([...sel.options].some((o) => o.value === current)) sel.value = current;
}
async function openInput() {
  if (state.inputStream) state.inputStream.getTracks().forEach((t) => t.stop());
  state.inputStream = await navigator.mediaDevices.getUserMedia({
    audio: { deviceId: state.inputDeviceId !== 'default' ? { exact: state.inputDeviceId } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });
  setupMonitorAndAnalyser();
  return state.inputStream;
}
function setupMonitorAndAnalyser() {
  const c = ctx();
  const src = c.createMediaStreamSource(state.inputStream);
  if (!state.monitorGain) { state.monitorGain = c.createGain(); state.monitorGain.connect(c.destination); }
  state.monitorGain.gain.value = state.monitor ? 1 : 0;
  src.connect(state.monitorGain);
  state.analyser = c.createAnalyser(); state.analyser.fftSize = 1024; state.liveBuf = new Float32Array(state.analyser.fftSize);
  src.connect(state.analyser); state.monitorSource = src;
}

// ===========================================================================
// Waveform helpers
// ===========================================================================
function computePeaks(buffer, pps) {
  const cols = Math.max(1, Math.ceil(buffer.duration * pps));
  const chs = []; for (let c = 0; c < buffer.numberOfChannels; c++) chs.push(buffer.getChannelData(c));
  const spp = buffer.length / cols; const peaks = new Float32Array(cols * 2);
  for (let x = 0; x < cols; x++) {
    const s = Math.floor(x * spp), e = Math.min(buffer.length, Math.floor((x + 1) * spp));
    let mn = 0, mx = 0;
    for (let i = s; i < e; i++) { let v = 0; for (let c = 0; c < chs.length; c++) v += chs[c][i]; v /= chs.length; if (v < mn) mn = v; if (v > mx) mx = v; }
    peaks[x * 2] = mn; peaks[x * 2 + 1] = mx;
  }
  return peaks;
}
function drawPeaksRange(canvas, peaks, h, color, startCol, endCol) {
  const total = peaks.length / 2;
  startCol = Math.max(0, startCol); endCol = Math.min(total, Math.max(startCol + 1, endCol));
  const w = endCol - startCol;
  canvas.width = Math.max(1, w); canvas.height = h;
  const g = canvas.getContext('2d'); g.clearRect(0, 0, canvas.width, h);
  const mid = h / 2, amp = h / 2 * 0.92; g.strokeStyle = color; g.lineWidth = 1; g.beginPath();
  for (let x = 0; x < w; x++) { const c = startCol + x, mn = peaks[c * 2], mx = peaks[c * 2 + 1]; g.moveTo(x + 0.5, mid - mx * amp); g.lineTo(x + 0.5, Math.max(mid - mn * amp, mid - mx * amp + 0.5)); }
  g.stroke();
}
function roundRect(g, x, y, w, h, r) { r = Math.min(r, w / 2, h / 2); g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
function drawMini(canvas, peaks, color) {
  const dpr = window.devicePixelRatio || 1, cssW = canvas.clientWidth || 260, cssH = 36;
  canvas.width = Math.round(cssW * dpr); canvas.height = Math.round(cssH * dpr);
  const g = canvas.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, cssW, cssH);
  g.fillStyle = '#1f2a2c'; roundRect(g, 0, 0, cssW, cssH, 7); g.fill();
  const cols = peaks.length / 2, barW = 2.5, gap = 1.6, step = barW + gap;
  const n = Math.max(1, Math.floor((cssW - 6) / step)), mid = cssH / 2, maxAmp = cssH / 2 - 4;
  g.fillStyle = color || '#9cb080';
  for (let i = 0; i < n; i++) {
    const c0 = Math.floor(i / n * cols), c1 = Math.max(c0 + 1, Math.floor((i + 1) / n * cols));
    let amp = 0; for (let x = c0; x < c1 && x < cols; x++) { const a = Math.max(Math.abs(peaks[x * 2]), Math.abs(peaks[x * 2 + 1])); if (a > amp) amp = a; }
    const barH = Math.max(2.5, amp * maxAmp * 2), bx = 3 + i * step + gap / 2;
    roundRect(g, bx, mid - barH / 2, barW, barH, barW / 2); g.fill();
  }
}

// ===========================================================================
// Undo / Redo
// ===========================================================================
function snap() {
  return {
    trackSeq: state.trackSeq, selectedTrackId: state.selectedTrackId,
    tracks: state.tracks.map((tr) => ({
      id: tr.id, name: tr.name, color: tr.color, clipSeq: tr.clipSeq, selectedClipId: tr.selectedClipId,
      clips: tr.clips.map((c) => ({ id: c.id, num: c.num, offset: c.offset, trimStart: c.trimStart, trimEnd: c.trimEnd, createdAt: c.createdAt, buffer: c.buffer })),
    })),
  };
}
function pushUndo() { state.undoStack.push(snap()); if (state.undoStack.length > 80) state.undoStack.shift(); state.redoStack = []; }
function restore(s) {
  state.trackSeq = s.trackSeq; state.selectedTrackId = s.selectedTrackId;
  state.tracks = s.tracks.map((t) => ({
    id: t.id, name: t.name, color: t.color, clipSeq: t.clipSeq, selectedClipId: t.selectedClipId, els: null,
    clips: t.clips.map((c) => ({ id: c.id, num: c.num, offset: c.offset, trimStart: c.trimStart, trimEnd: c.trimEnd, createdAt: c.createdAt, buffer: c.buffer, peaks: null, els: null })),
  }));
  buildTracksDOM(); layout(); renderTakesWindow();
}
function undo() { if (!state.undoStack.length) { showToast('Nothing to undo'); return; } state.redoStack.push(snap()); restore(state.undoStack.pop()); showToast('Undo'); }
function redo() { if (!state.redoStack.length) { showToast('Nothing to redo'); return; } state.undoStack.push(snap()); restore(state.redoStack.pop()); showToast('Redo'); }

// ===========================================================================
// Track / clip model
// ===========================================================================
function selectedTrack() { return state.tracks.find((t) => t.id === state.selectedTrackId) || null; }
function trackById(id) { return state.tracks.find((t) => t.id === id) || null; }
function visDur(c) { return c.trimEnd - c.trimStart; }
function clipEnd(c) { return c.offset + visDur(c); }

function addTrack(silent) {
  state.trackSeq++;
  const tr = { id: ++idCounter, name: `Track ${state.trackSeq}`, color: TRACK_COLORS[(state.trackSeq - 1) % TRACK_COLORS.length], clips: [], clipSeq: 0, selectedClipId: null, els: null };
  state.tracks.push(tr);
  state.selectedTrackId = tr.id;
  buildTracksDOM();
  if (!silent) { layout(); renderTakesWindow(); }
  return tr;
}
function userAddTrack() { pushUndo(); addTrack(false); showToast('Track added'); }
function deleteTrack(id) {
  pushUndo();
  state.tracks = state.tracks.filter((t) => t.id !== id);
  if (state.selectedTrackId === id) state.selectedTrackId = state.tracks.length ? state.tracks[state.tracks.length - 1].id : null;
  buildTracksDOM(); layout(); renderTakesWindow();
}
function selectTrack(id) { if (state.selectedTrackId !== id) { state.selectedTrackId = id; updateSelectionUI(); renderTakesWindow(); } }
function selectClip(tr, clipId) { state.selectedTrackId = tr.id; tr.selectedClipId = clipId; updateSelectionUI(); renderTakesWindow(); }
function addClip(tr, buffer, offset) {
  tr.clipSeq++;
  const c = { id: ++idCounter, num: tr.clipSeq, offset: Math.max(0, offset || 0), buffer, peaks: null, trimStart: 0, trimEnd: buffer.duration, createdAt: new Date(), els: null };
  tr.clips.push(c); tr.selectedClipId = c.id;
  return c;
}
function removeClip(tr, clipId) {
  pushUndo();
  tr.clips = tr.clips.filter((c) => c.id !== clipId);
  if (tr.selectedClipId === clipId) tr.selectedClipId = tr.clips.length ? tr.clips[tr.clips.length - 1].id : null;
  renderTrackClips(tr); layout(); renderTakesWindow();
}
function clipUnderPlayhead(tr) { return tr.clips.find((c) => state.playhead >= c.offset - 0.001 && state.playhead < clipEnd(c) + 0.001) || null; }

// ===========================================================================
// Track / clip DOM
// ===========================================================================
function buildTracksDOM() {
  el.trackLabels.innerHTML = ''; el.trackLanes.innerHTML = '';
  state.tracks.forEach((tr) => {
    const label = document.createElement('div');
    label.className = 'lane-label track'; label.style.setProperty('--tc', tr.color);
    label.innerHTML = `<div class="ll-row"><span class="swatch"></span><span class="ll-title"></span><span class="ll-rec hidden"><span class="dot"></span>REC</span></div>`;
    label.querySelector('.swatch').style.background = tr.color;
    label.querySelector('.ll-title').textContent = tr.name;
    label.addEventListener('click', () => selectTrack(tr.id));
    label.addEventListener('contextmenu', (e) => { e.preventDefault(); selectTrack(tr.id); showTrackMenu(e, tr); });

    const body = document.createElement('div');
    body.className = 'lane-body track'; body.dataset.track = tr.id; body.style.setProperty('--tc', tr.color);
    body.addEventListener('pointerdown', (e) => { if (e.button !== 0 || e.target.closest('.clip')) return; selectTrack(tr.id); timelineDown(e); });
    body.addEventListener('contextmenu', (e) => { if (e.target.closest('.clip')) return; e.preventDefault(); selectTrack(tr.id); showTrackMenu(e, tr); });

    el.trackLabels.appendChild(label); el.trackLanes.appendChild(body);
    tr.els = { label, body, title: label.querySelector('.ll-title'), rec: label.querySelector('.ll-rec') };
    renderTrackClips(tr);
  });
  updateSelectionUI(); updatePlayheadHeight();
}
function renderTrackClips(tr) {
  if (!tr.els) return;
  const body = tr.els.body;
  body.querySelectorAll('.clip:not(.rec-temp)').forEach((n) => n.remove());
  tr.clips.forEach((clip) => {
    const clipEl = document.createElement('div');
    clipEl.className = 'clip';
    clipEl.setAttribute('data-title', 'Audio Clip');
    clipEl.setAttribute('data-tip', 'মাঝখান টেনে সরান; দুই প্রান্ত টেনে ছোট/বড় করুন। ডান-ক্লিকে অপশন।');
    const trimL = document.createElement('div'); trimL.className = 'trim left';
    const trimR = document.createElement('div'); trimR.className = 'trim right';
    const canvas = document.createElement('canvas');
    clipEl.appendChild(trimL); clipEl.appendChild(canvas); clipEl.appendChild(trimR);
    body.appendChild(clipEl);
    clip.els = { clipEl, canvas, trimL, trimR };
    clipEl.addEventListener('pointerdown', (e) => { if (e.button !== 0 || e.target.closest('.trim')) return; e.stopPropagation(); moveClip(e, tr, clip); });
    trimL.addEventListener('pointerdown', (e) => { if (e.button !== 0) return; e.stopPropagation(); trimClip(e, tr, clip, 'l'); });
    trimR.addEventListener('pointerdown', (e) => { if (e.button !== 0) return; e.stopPropagation(); trimClip(e, tr, clip, 'r'); });
    clipEl.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); selectClip(tr, clip.id); showClipMenu(e, tr, clip); });
    positionClip(tr, clip);
  });
  highlightClips(tr);
}
function positionClip(tr, clip) {
  const { clipEl, canvas } = clip.els; const vd = visDur(clip), w = Math.max(4, Math.round(vd * PPS));
  clipEl.style.left = Math.round(clip.offset * PPS) + 'px'; clipEl.style.width = w + 'px';
  clipEl.style.borderColor = tr.color; clipEl.style.background = 'color-mix(in srgb, ' + tr.color + ' 22%, #223230)';
  if (!clip.peaks) clip.peaks = computePeaks(clip.buffer, PPS);
  drawPeaksRange(canvas, clip.peaks, WAVE_H, tr.color, Math.floor(clip.trimStart * PPS), Math.ceil(clip.trimEnd * PPS));
  canvas.style.width = w + 'px'; canvas.style.height = WAVE_H + 'px';
}
function highlightClips(tr) { tr.clips.forEach((c) => c.els && c.els.clipEl.classList.toggle('selected', tr.selectedClipId === c.id && tr.id === state.selectedTrackId)); }
function updateSelectionUI() {
  state.tracks.forEach((tr) => {
    if (!tr.els) return;
    const sel = tr.id === state.selectedTrackId;
    tr.els.label.classList.toggle('selected', sel);
    tr.els.body.classList.toggle('selected', sel);
    tr.els.rec.classList.toggle('hidden', !sel);
    highlightClips(tr);
  });
}
function updatePlayheadHeight() { el.playhead.style.height = (RULER_H + state.tracks.length * TRACK_H) + 'px'; }

// ---- clip interactions ----
function moveClip(e, tr, clip) {
  selectClip(tr, clip.id); pushUndo();
  const d = { x: e.clientX, off: clip.offset };
  const move = (ev) => { clip.offset = Math.max(0, d.off + (ev.clientX - d.x) / PPS); positionClip(tr, clip); renderPlayhead(); };
  const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); layout(); };
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
}
function trimClip(e, tr, clip, side) {
  selectClip(tr, clip.id); pushUndo();
  const d = { x: e.clientX, ts: clip.trimStart, te: clip.trimEnd, off: clip.offset };
  const move = (ev) => {
    const dx = (ev.clientX - d.x) / PPS;
    if (side === 'l') { let nts = Math.min(Math.max(0, d.ts + dx), clip.trimEnd - 0.05); const ap = nts - d.ts; clip.trimStart = nts; clip.offset = Math.max(0, d.off + ap); }
    else { clip.trimEnd = Math.min(clip.buffer.duration, Math.max(clip.trimStart + 0.05, d.te + dx)); }
    positionClip(tr, clip); renderPlayhead();
  };
  const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); layout(); };
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
}

async function loadFileInto(tr) {
  const res = await ipcRenderer.invoke('open-audio');
  if (!res.ok) return;
  try {
    const buf = await ctx().decodeAudioData(res.data.slice(0));
    pushUndo();
    addClip(tr, buf, state.playhead);
    selectTrack(tr.id); renderTrackClips(tr); layout(); renderTakesWindow();
    showToast(`Loaded into ${tr.name}`);
  } catch (e) { console.error(e); showToast('Could not decode that file'); }
}
function loadIntoSelected() { let tr = selectedTrack(); if (!tr) tr = addTrack(true); loadFileInto(tr); }

// ===========================================================================
// Context menus
// ===========================================================================
function menuItem(m, label, fn, cls) { const it = document.createElement('div'); it.className = 'ctx-item' + (cls ? ' ' + cls : ''); it.textContent = label; it.onclick = () => { hideCtx(); fn(); }; m.appendChild(it); }
function placeMenu(e) { const m = el.ctxMenu; m.classList.remove('hidden'); const mw = m.offsetWidth, mh = m.offsetHeight; m.style.left = Math.min(e.clientX, window.innerWidth - mw - 6) + 'px'; m.style.top = Math.min(e.clientY, window.innerHeight - mh - 6) + 'px'; }
function showTrackMenu(e, tr) {
  const m = el.ctxMenu; m.innerHTML = '';
  menuItem(m, 'Load audio into track…', () => loadFileInto(tr));
  const sep = document.createElement('div'); sep.className = 'ctx-sep'; m.appendChild(sep);
  menuItem(m, 'Delete track', () => deleteTrack(tr.id), 'danger');
  placeMenu(e);
}
function showClipMenu(e, tr, clip) {
  const m = el.ctxMenu; m.innerHTML = '';
  menuItem(m, 'Export WAV…', () => exportClip(clip, 'wav', tr));
  menuItem(m, 'Export MP3…', () => exportClip(clip, 'mp3', tr));
  const sep = document.createElement('div'); sep.className = 'ctx-sep'; m.appendChild(sep);
  menuItem(m, 'Delete clip', () => removeClip(tr, clip.id), 'danger');
  placeMenu(e);
}
function hideCtx() { el.ctxMenu.classList.add('hidden'); }

// ===========================================================================
// Timeline sizing / rendering
// ===========================================================================
function contentDuration() {
  let d = MIN_DURATION;
  state.tracks.forEach((tr) => tr.clips.forEach((c) => { d = Math.max(d, clipEnd(c)); }));
  if (state.recording) d = Math.max(d, state.playhead + 1);
  return d;
}
function invalidatePeaks() { state.tracks.forEach((tr) => tr.clips.forEach((c) => (c.peaks = null))); }
function layout() {
  const px = Math.ceil(contentDuration() * PPS);
  el.timeline.style.width = px + 'px'; el.rulerCanvas.style.width = px + 'px';
  drawRuler(px);
  if (!state.recording) state.tracks.forEach(renderTrackClips);
  updatePlayheadHeight();
  renderPlayhead();
}
function drawRuler(px) {
  const c = el.rulerCanvas, h = RULER_H; c.width = px; c.height = h;
  const g = c.getContext('2d'); g.fillStyle = '#1c2628'; g.fillRect(0, 0, px, h);
  g.strokeStyle = '#46594f'; g.fillStyle = '#8fa596'; g.font = '10px sans-serif'; g.lineWidth = 1;
  const secs = Math.ceil(px / PPS), labelEvery = PPS < 45 ? 5 : (PPS < 90 ? 2 : 1);
  for (let s = 0; s <= secs; s++) {
    const x = Math.round(s * PPS) + 0.5, major = s % labelEvery === 0;
    g.beginPath(); g.moveTo(x, h - (major ? 15 : 7)); g.lineTo(x, h); g.stroke();
    if (major) g.fillText(fmt(s), x + 3, 13);
  }
}
function renderPlayhead() { el.playhead.style.left = Math.round(state.playhead * PPS) + 'px'; el.clock.textContent = `${fmt(state.playhead, true)} / ${fmt(contentDuration(), true)}`; }
function fmt(s, tenths) { if (!isFinite(s)) s = 0; const m = Math.floor(s / 60), sec = Math.floor(s % 60).toString().padStart(2, '0'); if (tenths) return `${m}:${sec}.${Math.floor((s * 10) % 10)}`; return `${m}:${sec}`; }
function autoScroll() { const x = state.playhead * PPS, sc = el.timelineScroll; if (x < sc.scrollLeft + 40 || x > sc.scrollLeft + sc.clientWidth - 60) sc.scrollLeft = x - sc.clientWidth * 0.4; }

// ===========================================================================
// Zoom
// ===========================================================================
function setZoom(newPPS, anchorClientX) {
  newPPS = Math.max(PPS_MIN, Math.min(PPS_MAX, newPPS));
  if (Math.abs(newPPS - PPS) < 0.01) return;
  const sc = el.timelineScroll, rect = el.timeline.getBoundingClientRect();
  const cursorTime = (anchorClientX - rect.left) / PPS;
  PPS = newPPS; invalidatePeaks(); layout();
  sc.scrollLeft = cursorTime * PPS - (anchorClientX - sc.getBoundingClientRect().left);
  renderPlayhead();
}

// ===========================================================================
// Metronome
// ===========================================================================
function spb() { return 60 / state.bpm; }
function bpb() { return parseInt(el.beatsPerBar.value, 10) || 4; }
function click(time, accent, countin) {
  const c = state.ctx, o = c.createOscillator(), g = c.createGain();
  const v = parseFloat(el.clickVol.value) * (countin ? 0.9 : 1);
  o.frequency.value = accent ? 1500 : 900;
  g.gain.setValueAtTime(0.0001, time); g.gain.exponentialRampToValueAtTime(Math.max(0.0002, v), time + 0.001); g.gain.exponentialRampToValueAtTime(0.0001, time + 0.05);
  o.connect(g); g.connect(c.destination); o.start(time); o.stop(time + 0.06);
}
function scheduler() {
  const c = state.ctx;
  while (state.nextNoteTime < c.currentTime + 0.12) {
    const beatInBar = state.beatCounter % bpb(), countin = state.countInLeft > 0;
    click(state.nextNoteTime, beatInBar === 0, countin);
    if (countin) { state.countInLeft--; if (state.countInLeft === 0 && state.onDownbeat) { const cb = state.onDownbeat; state.onDownbeat = null; cb(state.nextNoteTime + spb()); } }
    state.nextNoteTime += spb(); state.beatCounter++;
  }
  state.timerId = setTimeout(scheduler, 25);
}
function startMetronome(countInBars, onDownbeat) {
  const c = ctx();
  state.beatCounter = 0; state.countInLeft = (countInBars || 0) * bpb(); state.onDownbeat = onDownbeat || null;
  state.nextNoteTime = c.currentTime + 0.1; state.metroRunning = true;
  if (state.countInLeft === 0 && state.onDownbeat) { const cb = state.onDownbeat; state.onDownbeat = null; cb(state.nextNoteTime); }
  scheduler();
}
function stopMetronome() { state.metroRunning = false; if (state.timerId) { clearTimeout(state.timerId); state.timerId = null; } state.onDownbeat = null; }

// ===========================================================================
// Playback
// ===========================================================================
function stopSources() { state.playSources.forEach((s) => { try { s.stop(); } catch (_) {} }); state.playSources = []; }
function scheduleClip(clip, head, ctxStart) {
  const start = clip.offset, vd = visDur(clip), end = start + vd;
  if (end <= head) return;
  const s = state.ctx.createBufferSource(); s.buffer = clip.buffer; s.connect(state.tracksGain);
  if (head <= start) s.start(ctxStart + (start - head), clip.trimStart, vd);
  else { const into = head - start; s.start(ctxStart, clip.trimStart + into, vd - into); }
  state.playSources.push(s);
}
function scheduleAll(head, ctxStart, exceptTrackId) {
  state.tracks.forEach((tr) => { if (tr.id === exceptTrackId) return; tr.clips.forEach((c) => scheduleClip(c, head, ctxStart)); });
}
function startPlayback() {
  const c = ctx(); applyOutput(); stopSources();
  const ctxStart = c.currentTime + 0.06; state.playStartCtx = ctxStart; state.playStartHead = state.playhead;
  scheduleAll(state.playhead, ctxStart, null);
  state.playing = true; updatePlayIcon(); tickPlayhead();
}
function tickPlayhead() {
  if (!state.playing) return;
  state.playhead = state.playStartHead + (state.ctx.currentTime - state.playStartCtx);
  if (state.playhead >= contentDuration()) { state.playhead = contentDuration(); pausePlayback(); return; }
  renderPlayhead(); autoScroll(); state.raf = requestAnimationFrame(tickPlayhead);
}
function pausePlayback() {
  if (!state.playing) return;
  state.playhead = state.playStartHead + (state.ctx.currentTime - state.playStartCtx);
  state.playing = false; stopSources(); if (state.raf) cancelAnimationFrame(state.raf); updatePlayIcon(); renderPlayhead();
}
function seek(seconds, keepPlaying) { state.playhead = Math.max(0, Math.min(seconds, contentDuration())); if (state.playing && keepPlaying) { stopSources(); startPlayback(); } renderPlayhead(); }
function updatePlayIcon() { el.playPauseBtn.innerHTML = state.playing ? ICON_PAUSE : ICON_PLAY; el.playPauseBtn.classList.toggle('playing', state.playing); }

// ===========================================================================
// Recording
// ===========================================================================
async function beginRecording(editing) {
  if (state.recording) return;
  let tr = selectedTrack(); if (!tr) tr = addTrack(true);
  ctx(); await applyOutput();
  try { await openInput(); } catch (e) { console.error(e); showToast('Cannot open input device'); return; }

  state.recording = true; state.editing = editing; state.recTrackId = tr.id;
  state.recStartHead = state.playhead; state.livePeaks = [];
  el.recordBtn.classList.add('armed');
  // temp recording clip element
  const recEl = document.createElement('div'); recEl.className = 'clip rec-temp recording';
  const canvas = document.createElement('canvas'); recEl.appendChild(canvas); tr.els.body.appendChild(recEl);
  state.recEl = { recEl, canvas };
  const countInBars = parseInt(el.countIn.value, 10) || 0;
  showToast(countInBars ? 'Counting in…' : `Recording into ${tr.name}…`);
  const onDown = (downCtxTime) => {
    const delay = Math.max(0, (downCtxTime - state.ctx.currentTime) * 1000);
    setTimeout(() => {
      if (!state.recording) return;
      state.recChunks = [];
      const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
      state.recorder = new MediaRecorder(state.inputStream, { mimeType: mime });
      state.recorder.ondataavailable = (e) => { if (e.data.size) state.recChunks.push(e.data); };
      state.recorder.onstop = finalizeRecording;
      state.recStartCtx = state.ctx.currentTime; state.recorder.start(); recFrame();
    }, delay);
    scheduleAll(state.recStartHead, downCtxTime, tr.id); // hear other tracks
  };
  startMetronome(countInBars, onDown);
}
function recFrame() {
  if (!state.recording || !state.recorder) return;
  const elapsed = Math.max(0, state.ctx.currentTime - state.recStartCtx);
  state.playhead = state.recStartHead + elapsed;
  state.analyser.getFloatTimeDomainData(state.liveBuf);
  let mx = 0; for (let i = 0; i < state.liveBuf.length; i++) { const a = Math.abs(state.liveBuf[i]); if (a > mx) mx = a; }
  const need = Math.floor((state.playhead - state.recStartHead) * PPS);
  while (state.livePeaks.length <= need) state.livePeaks.push(mx);
  drawRecordingClip();
  const px = Math.ceil(contentDuration() * PPS);
  el.timeline.style.width = px + 'px'; el.rulerCanvas.style.width = px + 'px'; drawRuler(px);
  renderPlayhead(); autoScroll();
  state.recRaf = requestAnimationFrame(recFrame);
}
function drawRecordingClip() {
  if (!state.recEl) return;
  const { recEl, canvas } = state.recEl;
  recEl.style.left = Math.round(state.recStartHead * PPS) + 'px';
  recEl.style.width = Math.max(2, state.livePeaks.length) + 'px';
  const w = Math.max(1, state.livePeaks.length), h = WAVE_H;
  canvas.width = w; canvas.height = h; canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
  const g = canvas.getContext('2d'); g.clearRect(0, 0, w, h); const mid = h / 2, amp = h / 2 * 0.92;
  g.strokeStyle = '#e0776a'; g.lineWidth = 1; g.beginPath();
  for (let i = 0; i < state.livePeaks.length; i++) { const v = state.livePeaks[i]; g.moveTo(i + 0.5, mid - v * amp); g.lineTo(i + 0.5, mid + v * amp); }
  g.stroke();
}
function stopRecording() {
  if (state.recRaf) cancelAnimationFrame(state.recRaf);
  if (state.recorder && state.recorder.state !== 'inactive') state.recorder.stop(); else finalizeRecording();
  stopMetronome(); stopSources(); state.recording = false; el.recordBtn.classList.remove('armed');
}
async function finalizeRecording() {
  el.recordBtn.classList.remove('armed');
  const editing = state.editing, tr = trackById(state.recTrackId); state.editing = false; state.recording = false;
  if (state.recEl) { state.recEl.recEl.remove(); state.recEl = null; }
  if (!state.recChunks || !state.recChunks.length) { if (tr) renderTrackClips(tr); showToast('Nothing captured'); return; }
  const blob = new Blob(state.recChunks, { type: state.recorder.mimeType });
  let recBuf; try { recBuf = await ctx().decodeAudioData((await blob.arrayBuffer()).slice(0)); } catch (e) { console.error('decode', e); showToast('Decode failed'); return; }
  if (!tr) return;
  pushUndo();
  const under = clipUnderPlayheadAt(tr, state.recStartHead);
  if (editing && under) {
    const keep = Math.max(0, state.recStartHead - under.offset);
    under.buffer = concatBuffers(ctx(), under.buffer, keep, recBuf); under.trimStart = 0; under.trimEnd = under.buffer.duration; under.peaks = null;
    tr.selectedClipId = under.id;
    showToast(`Overdubbed ${tr.name} · clip #${under.num}`);
  } else {
    const overlaps = tr.clips.some((c) => state.recStartHead < clipEnd(c) && state.recStartHead + recBuf.duration > c.offset);
    const clip = addClip(tr, recBuf, state.recStartHead);
    showToast(overlaps ? `Recorded (overlaps an existing clip — both kept)` : `${tr.name} · clip #${clip.num} recorded`);
  }
  state.playhead = state.recStartHead; renderTrackClips(tr); layout(); renderTakesWindow();
}
function clipUnderPlayheadAt(tr, t) { return tr.clips.find((c) => t >= c.offset - 0.001 && t < clipEnd(c) + 0.001) || null; }
function concatBuffers(c, a, keepSeconds, b) {
  const sr = a.sampleRate, keep = Math.max(0, Math.min(a.length, Math.floor(keepSeconds * sr))), numCh = Math.max(a.numberOfChannels, b.numberOfChannels);
  const out = c.createBuffer(numCh, keep + b.length, sr);
  for (let ch = 0; ch < numCh; ch++) {
    const od = out.getChannelData(ch), ad = a.getChannelData(Math.min(ch, a.numberOfChannels - 1));
    for (let i = 0; i < keep; i++) od[i] = ad[i];
    const bd = b.getChannelData(Math.min(ch, b.numberOfChannels - 1));
    for (let i = 0; i < b.length; i++) od[keep + i] = bd[i];
  }
  return out;
}

// ===========================================================================
// Takes drawer (selected track's clips)
// ===========================================================================
function renderTakesWindow() {
  const tr = selectedTrack();
  el.tpTrack.textContent = tr ? tr.name : '';
  el.tpBody.innerHTML = '';
  if (!tr || !tr.clips.length) { el.tpBody.innerHTML = '<div class="tw-empty">No recordings on this track yet.</div>'; return; }
  [...tr.clips].sort((a, b) => b.num - a.num).forEach((clip) => {
    const item = document.createElement('div');
    item.className = 'take-item' + (clip.id === tr.selectedClipId ? ' current' : '');
    item.setAttribute('data-title', 'Take'); item.setAttribute('data-tip', 'ক্লিক করে টাইমলাইনে এই রেকর্ডিং-এ যান।');
    item.innerHTML = `
      <div class="take-num">#${clip.num}</div>
      <div class="take-mini"><canvas></canvas><div class="take-meta">${fmt(visDur(clip))} · @ ${fmt(clip.offset)}</div></div>
      <div class="take-ctrls">
        <button data-a="wav" data-title="Export WAV" data-tip="লসলেস WAV হিসেবে সেভ করুন।">WAV</button>
        <button data-a="mp3" data-title="Export MP3" data-tip="১৯২ kbps MP3 হিসেবে সেভ করুন।">MP3</button>
        <button data-a="del" class="icon-only" data-title="Delete" data-tip="এই রেকর্ডিং মুছে ফেলুন।">${SVG_TRASH}</button>
      </div>`;
    item.onclick = (e) => { if (!e.target.closest('button')) { selectClip(tr, clip.id); el.timelineScroll.scrollLeft = clip.offset * PPS - 60; } };
    item.querySelector('[data-a="wav"]').onclick = () => exportClip(clip, 'wav', tr);
    item.querySelector('[data-a="mp3"]').onclick = () => exportClip(clip, 'mp3', tr);
    item.querySelector('[data-a="del"]').onclick = () => removeClip(tr, clip.id);
    el.tpBody.appendChild(item);
    if (!clip.peaks) clip.peaks = computePeaks(clip.buffer, PPS);
    requestAnimationFrame(() => drawMini(item.querySelector('canvas'), clip.peaks, tr.color));
  });
}
function toggleTakesWindow(force) {
  const collapsed = el.takesPanel.classList.contains('collapsed');
  const show = force !== undefined ? force : collapsed;
  el.takesPanel.classList.toggle('collapsed', !show);
  el.takesBtn.classList.toggle('active', show);
  if (show) renderTakesWindow();
}

// ===========================================================================
// Export
// ===========================================================================
function trimmedBuffer(clip) {
  // Render only the visible (trimmed) region for export.
  const b = clip.buffer, sr = b.sampleRate;
  const s = Math.floor(clip.trimStart * sr), e = Math.min(b.length, Math.floor(clip.trimEnd * sr));
  const len = Math.max(1, e - s), out = ctx().createBuffer(b.numberOfChannels, len, sr);
  for (let ch = 0; ch < b.numberOfChannels; ch++) { const src = b.getChannelData(ch), dst = out.getChannelData(ch); for (let i = 0; i < len; i++) dst[i] = src[s + i] || 0; }
  return out;
}
async function exportClip(clip, format, tr) {
  showToast(`Exporting ${format.toUpperCase()}…`);
  const buf = trimmedBuffer(clip);
  const bytes = format === 'wav' ? encodeWav(buf) : encodeMp3(buf);
  const base = `${(tr ? tr.name : 'Clip').replace(/\s+/g, '_')}_clip${clip.num}`;
  const res = await ipcRenderer.invoke('save-file', { defaultName: `${base}.${format}`, data: bytes });
  showToast(res.ok ? 'Exported' : 'Cancelled');
}
function encodeWav(buffer) {
  const numCh = buffer.numberOfChannels, sr = buffer.sampleRate, len = buffer.length, blockAlign = numCh * 2, dataSize = len * blockAlign;
  const b = new ArrayBuffer(44 + dataSize), v = new DataView(b);
  const ws = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  ws(0, 'RIFF'); v.setUint32(4, 36 + dataSize, true); ws(8, 'WAVE'); ws(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, numCh, true); v.setUint32(24, sr, true); v.setUint32(28, sr * blockAlign, true); v.setUint16(32, blockAlign, true); v.setUint16(34, 16, true);
  ws(36, 'data'); v.setUint32(40, dataSize, true);
  const chs = []; for (let c = 0; c < numCh; c++) chs.push(buffer.getChannelData(c)); let off = 44;
  for (let i = 0; i < len; i++) for (let c = 0; c < numCh; c++) { let s = Math.max(-1, Math.min(1, chs[c][i])); v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true); off += 2; }
  return new Uint8Array(b);
}
function encodeMp3(buffer) {
  const numCh = Math.min(2, buffer.numberOfChannels), sr = buffer.sampleRate, enc = new lamejs.Mp3Encoder(numCh, sr, 192);
  const L = f2i(buffer.getChannelData(0)), R = numCh > 1 ? f2i(buffer.getChannelData(1)) : null, bs = 1152, data = [];
  for (let i = 0; i < L.length; i += bs) { const l = L.subarray(i, i + bs); const chunk = numCh > 1 ? enc.encodeBuffer(l, R.subarray(i, i + bs)) : enc.encodeBuffer(l); if (chunk.length) data.push(chunk); }
  const end = enc.flush(); if (end.length) data.push(end);
  let total = 0; data.forEach((d) => (total += d.length)); const out = new Uint8Array(total); let o = 0; data.forEach((d) => { out.set(d, o); o += d.length; });
  return out;
}
function f2i(fa) { const o = new Int16Array(fa.length); for (let i = 0; i < fa.length; i++) { const s = Math.max(-1, Math.min(1, fa[i])); o[i] = s < 0 ? s * 0x8000 : s * 0x7FFF; } return o; }

// ===========================================================================
// Test tone
// ===========================================================================
async function testOutput() {
  const c = ctx(); await applyOutput(); const t = c.currentTime;
  [523.25, 659.25, 783.99].forEach((freq, i) => {
    const o = c.createOscillator(), g = c.createGain(); o.type = 'sine'; o.frequency.value = freq; const s = t + i * 0.14;
    g.gain.setValueAtTime(0.0001, s); g.gain.exponentialRampToValueAtTime(0.22, s + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, s + 0.34);
    o.connect(g); g.connect(c.destination); o.start(s); o.stop(s + 0.36);
  });
  showToast('Test tone sent to output');
}

// ===========================================================================
// Pointer: seek
// ===========================================================================
function xToSeconds(clientX) { const r = el.timeline.getBoundingClientRect(); return Math.max(0, (clientX - r.left) / PPS); }
let seeking = false;
function timelineDown(e) {
  if (e.target.closest('.clip')) return;
  seeking = true; seek(xToSeconds(e.clientX), true);
  window.addEventListener('pointermove', timelineMove); window.addEventListener('pointerup', timelineUp);
}
function timelineMove(e) { if (seeking) seek(xToSeconds(e.clientX), true); }
function timelineUp() { seeking = false; window.removeEventListener('pointermove', timelineMove); window.removeEventListener('pointerup', timelineUp); }

// ===========================================================================
// Toast
// ===========================================================================
let toastTimer = null;
function showToast(msg) { el.toast.textContent = msg; el.toast.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.toast.classList.remove('show'), 1900); }

// ===========================================================================
// BPM control
// ===========================================================================
function setBpm(v) { state.bpm = Math.min(300, Math.max(30, Math.round(v))); el.bpmValue.textContent = state.bpm; }
function holdRepeat(btn, dir) {
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault(); setBpm(state.bpm + dir); let speed = 300, kick, iv;
    const step = () => { setBpm(state.bpm + dir); speed = Math.max(35, speed * 0.8); iv = setTimeout(step, speed); };
    kick = setTimeout(step, 340);
    const stop = () => { clearTimeout(kick); clearTimeout(iv); window.removeEventListener('pointerup', stop); window.removeEventListener('pointercancel', stop); };
    window.addEventListener('pointerup', stop); window.addEventListener('pointercancel', stop);
  });
}
function initBpmDrag() {
  el.bpmValue.addEventListener('pointerdown', (e) => {
    e.preventDefault(); const y0 = e.clientY, b0 = state.bpm;
    const move = (ev) => setBpm(b0 + Math.round((y0 - ev.clientY) / 3));
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  });
}

// ===========================================================================
// Tooltips (English name + localized body)
// ===========================================================================
let tipTimer = null;
function showTip(node) {
  const title = node.getAttribute('data-title') || '';
  const bn = node.getAttribute('data-tip') || '';
  const en = EN_BODY[title] || bn;
  const body = state.lang === 'bn' ? bn : en;
  if (!title && !body) return;
  const tip = el.tooltip;
  tip.innerHTML = (title ? `<div class="tt-title">${title}</div>` : '') + (body ? `<div class="tt-body">${body}</div>` : '');
  tip.classList.add('show');
  const r = node.getBoundingClientRect(), tw = tip.offsetWidth, th = tip.offsetHeight;
  let left = r.left + r.width / 2 - tw / 2; left = Math.max(6, Math.min(left, window.innerWidth - tw - 6));
  let top = r.bottom + 8; if (top + th > window.innerHeight - 6) top = r.top - th - 8;
  tip.style.left = left + 'px'; tip.style.top = top + 'px'; tip.style.setProperty('--arrow', (r.left + r.width / 2 - left - 5) + 'px');
}
function hideTip() { el.tooltip.classList.remove('show'); }
document.addEventListener('pointerover', (e) => { const n = e.target.closest('[data-tip],[data-title]'); if (!n) return; clearTimeout(tipTimer); tipTimer = setTimeout(() => showTip(n), 350); });
document.addEventListener('pointerout', (e) => { if (e.target.closest('[data-tip],[data-title]')) { clearTimeout(tipTimer); hideTip(); } });
document.addEventListener('pointerdown', (e) => { clearTimeout(tipTimer); hideTip(); if (!e.target.closest('#ctxMenu')) hideCtx(); });

// ===========================================================================
// Wiring
// ===========================================================================
el.metroBtn.onclick = () => { if (state.metroRunning) { stopMetronome(); el.metroBtn.classList.remove('active'); } else { el.metroBtn.classList.add('active'); startMetronome(0, null); } };
el.recordBtn.onclick = () => { if (state.recording) stopRecording(); else beginRecording(state.editMode); };
el.editBtn.onclick = () => { state.editMode = !state.editMode; el.editBtn.classList.toggle('editon', state.editMode); showToast(state.editMode ? 'Edit mode ON — Record overdubs the clip under the playhead' : 'Edit mode off'); };
el.playPauseBtn.onclick = () => { state.playing ? pausePlayback() : startPlayback(); };
el.stopBtn.onclick = () => { if (state.recording) stopRecording(); else { pausePlayback(); seek(0, false); } };
el.takesBtn.onclick = () => toggleTakesWindow();
el.tpHeader.onclick = () => toggleTakesWindow();
el.testBtn.onclick = testOutput;
el.addTrackBtn.onclick = userAddTrack;
el.addTrackRow.onclick = userAddTrack;
el.loadBackingBtn.onclick = loadIntoSelected;
el.settingsBtn.onclick = () => { el.settingsPanel.classList.toggle('hidden'); el.settingsBtn.classList.toggle('active'); };
el.refreshDevices.onclick = listDevices;
el.inputDevice.onchange = () => (state.inputDeviceId = el.inputDevice.value);
el.outputDevice.onchange = () => { state.outputDeviceId = el.outputDevice.value; applyOutput(); };
el.monitorToggle.onchange = () => { state.monitor = el.monitorToggle.checked; if (state.monitorGain) state.monitorGain.gain.value = state.monitor ? 1 : 0; };
el.backingVol.oninput = () => { if (state.tracksGain) state.tracksGain.gain.value = parseFloat(el.backingVol.value); };
el.langSelect.onchange = () => { state.lang = el.langSelect.value; showToast(state.lang === 'bn' ? 'ভাষা: বাংলা' : 'Language: English'); };

holdRepeat(el.bpmUp, +1); holdRepeat(el.bpmDown, -1); initBpmDrag();

el.rulerCanvas.addEventListener('pointerdown', timelineDown);
el.timelineScroll.addEventListener('wheel', (e) => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); setZoom(PPS * Math.exp(-e.deltaY * 0.002), e.clientX); } }, { passive: false });

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.code === 'KeyZ') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && e.code === 'KeyY') { e.preventDefault(); redo(); return; }
  if (mod) return;
  if (e.repeat) return;
  if (e.code === 'Space') { e.preventDefault(); if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); state.playing ? pausePlayback() : startPlayback(); }
  else if (e.code === 'KeyR') { e.preventDefault(); if (state.recording) stopRecording(); else beginRecording(state.editMode); }
});

// Init
setBpm(100); updatePlayIcon();
addTrack(true); addTrack(true); state.selectedTrackId = state.tracks[0].id;
buildTracksDOM(); layout(); renderTakesWindow(); listDevices();
navigator.mediaDevices.addEventListener('devicechange', listDevices);
window.addEventListener('resize', renderTakesWindow);
setTimeout(() => el.splash && el.splash.classList.add('hide'), 1150);
