'use strict';

const { ipcRenderer } = require('electron');
// `lamejs` (MP3 encoder) is already a global from lamejs.min.js.

// ===========================================================================
// Config / State
// ===========================================================================
let PPS = 100;
const PPS_MIN = 6, PPS_MAX = 420;
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
  'Record': 'Record a new take into the selected track (R). Edit mode overdubs from the playhead.',
  'Edit Mode': 'When on, Record overdubs the current take instead of adding a new one.',
  'Play / Pause': 'Play or pause from the playhead. Spacebar also works.',
  'Stop': 'Stop recording or playback and return to the start.',
  'Tempo (BPM)': 'Hold the arrows, or drag the number up and down, to change the tempo.',
  'Beats per Bar': 'How many beats in each bar; beat 1 is accented.',
  'Count-in': 'Metronome bars before recording begins.',
  'Click Volume': 'Metronome click volume.',
  'Timeline': 'Playhead position / total length.',
  'Takes': "Show the selected track's takes.",
  'Test Output': 'Play a tone through the selected output device.',
  'Add Track': 'Add a new empty track.',
  'Load Track': 'Load an audio file into the selected track.',
  'Audio Setup': 'Choose input & output devices and the language.',
  'Zoom': 'Zoom the timeline: Ctrl + scroll, or pinch on a trackpad.',
  'Track Volume': 'Volume of this track.',
  'Mute': 'Silence this track.',
  'Solo': 'Play only the soloed track(s).',
  'Project': 'New, open, or save a project (Ctrl+N / Ctrl+O / Ctrl+S).',
  'Audio Clip': 'Drag the middle to move; drag the edges to resize. Right-click for options.',
  'Take': 'Click to show this take on the track.',
  'Use': 'Make this the active take on the track.',
  'Export WAV': 'Save as a lossless WAV file.',
  'Export MP3': 'Save as a 192 kbps MP3 file.',
  'Delete': 'Delete this take.',
  'Dawzer': 'A simple recording studio — record takes over a metronome.',
};

const state = {
  ctx: null, inputStream: null,
  inputDeviceId: 'default', outputDeviceId: 'default',
  monitor: false, monitorSource: null, monitorGain: null,
  lang: 'en',

  bpm: 100, editMode: false, metronomeOn: true, projectName: 'Untitled', dirty: false,
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
  'clock','projectBtn','takesBtn','testBtn','addTrackBtn','loadBackingBtn','settingsBtn',
  'settingsModal','settingsClose','settingsBackdrop','inputDevice','outputDevice','monitorToggle','langSelect','refreshDevices','deviceStatus',
  'labels','trackLabels','addTrackRow','trackLanes','timelineScroll','timeline','rulerCanvas','gridCanvas','playhead',
  'takesPanel','tpHeader','tpTrack','tpBody','toast','tooltip','ctxMenu','splash',
].forEach((id) => (el[id] = $(id)));

// ===========================================================================
// Audio context
// ===========================================================================
function ctx() {
  if (!state.ctx) state.ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (state.ctx.state === 'suspended') state.ctx.resume();
  return state.ctx;
}
function anySolo() { return state.tracks.some((t) => t.soloed); }
function trackAudible(tr) { return !tr.muted && (!anySolo() || tr.soloed); }
function trackGain(tr) {
  if (!tr.gainNode) { tr.gainNode = state.ctx.createGain(); tr.gainNode.connect(state.ctx.destination); }
  tr.gainNode.gain.value = trackAudible(tr) ? (tr.volume == null ? 1 : tr.volume) : 0;
  return tr.gainNode;
}
function applyTrackGains() { state.tracks.forEach((tr) => { if (tr.gainNode) tr.gainNode.gain.value = trackAudible(tr) ? (tr.volume == null ? 1 : tr.volume) : 0; }); }
function setMute(tr, val) { if (!tr) return; tr.muted = val; if (tr.els) tr.els.label.querySelector('.mute').classList.toggle('on', tr.muted); applyTrackGains(); markDirty(); }
function setSolo(tr, val) { if (!tr) return; tr.soloed = val; if (tr.els) tr.els.label.querySelector('.solo').classList.toggle('on', tr.soloed); applyTrackGains(); markDirty(); }
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
      id: tr.id, name: tr.name, color: tr.color, takeSeq: tr.takeSeq, activeTakeId: tr.activeTakeId, volume: tr.volume, muted: tr.muted, soloed: tr.soloed,
      takes: tr.takes.map((t) => ({ id: t.id, num: t.num, name: t.name, offset: t.offset, trimStart: t.trimStart, trimEnd: t.trimEnd, createdAt: t.createdAt, buffer: t.buffer })),
    })),
  };
}
function pushUndo() { state.undoStack.push(snap()); if (state.undoStack.length > 80) state.undoStack.shift(); state.redoStack = []; markDirty(); }
function markDirty() { state.dirty = true; }
function clearDirty() { state.dirty = false; }
function restore(s) {
  state.trackSeq = s.trackSeq; state.selectedTrackId = s.selectedTrackId;
  state.tracks = s.tracks.map((t) => ({
    id: t.id, name: t.name, color: t.color, takeSeq: t.takeSeq, activeTakeId: t.activeTakeId, volume: t.volume == null ? 1 : t.volume, muted: !!t.muted, soloed: !!t.soloed, gainNode: null, els: null,
    takes: t.takes.map((tk) => ({ id: tk.id, num: tk.num, name: tk.name || ('Take ' + tk.num), offset: tk.offset, trimStart: tk.trimStart, trimEnd: tk.trimEnd, createdAt: tk.createdAt, buffer: tk.buffer, peaks: null })),
  }));
  buildTracksDOM(); layout(); renderTakesWindow();
}
function undo() { if (!state.undoStack.length) { showToast('Nothing to undo'); return; } state.redoStack.push(snap()); restore(state.undoStack.pop()); showToast('Undo'); }
function redo() { if (!state.redoStack.length) { showToast('Nothing to redo'); return; } state.undoStack.push(snap()); restore(state.redoStack.pop()); showToast('Redo'); }

// ===========================================================================
// Track / take model  (one active take shown per track)
// ===========================================================================
function selectedTrack() { return state.tracks.find((t) => t.id === state.selectedTrackId) || null; }
function trackById(id) { return state.tracks.find((t) => t.id === id) || null; }
function activeTake(tr) { return tr ? (tr.takes.find((t) => t.id === tr.activeTakeId) || null) : null; }
function visDur(t) { return t.trimEnd - t.trimStart; }

function addTrack(silent) {
  state.trackSeq++;
  const tr = { id: ++idCounter, name: `Track ${state.trackSeq}`, color: TRACK_COLORS[(state.trackSeq - 1) % TRACK_COLORS.length], takes: [], takeSeq: 0, activeTakeId: null, volume: 1, muted: false, soloed: false, gainNode: null, els: null };
  state.tracks.push(tr);
  state.selectedTrackId = tr.id;
  buildTracksDOM();
  if (!silent) { layout(); renderTakesWindow(); }
  return tr;
}
function userAddTrack() { pushUndo(); addTrack(false); showToast('Track added'); }
function deleteTrack(id) {
  if (state.tracks.length <= 1) { showToast("Can't delete the only track"); return; }
  pushUndo();
  state.tracks = state.tracks.filter((t) => t.id !== id);
  if (state.selectedTrackId === id) state.selectedTrackId = state.tracks.length ? state.tracks[state.tracks.length - 1].id : null;
  buildTracksDOM(); layout(); renderTakesWindow();
}
function selectTrack(id) { if (state.recording) return; if (state.selectedTrackId !== id) { state.selectedTrackId = id; updateSelectionUI(); renderTakesWindow(); } }
function startRename(tr) {
  if (!tr.els) return;
  const title = tr.els.title;
  const input = document.createElement('input');
  input.className = 'track-rename'; input.value = tr.name; input.maxLength = 24;
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('pointerdown', (e) => e.stopPropagation());
  input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') input.blur(); else if (e.key === 'Escape') { input.value = tr.name; input.blur(); } });
  let done = false;
  const commit = () => {
    if (done) return; done = true;
    const v = input.value.trim();
    if (v && v !== tr.name) { pushUndo(); tr.name = v; }
    const span = document.createElement('span'); span.className = 'll-title'; span.textContent = tr.name;
    span.addEventListener('dblclick', (e) => { e.stopPropagation(); startRename(tr); });
    input.replaceWith(span); tr.els.title = span;
    renderTakesWindow();
  };
  input.addEventListener('blur', commit, { once: true });
  title.replaceWith(input); tr.els.title = input;
  input.focus(); input.select();
}
function addTake(tr, buffer, offset, name) {
  tr.takeSeq++;
  const t = { id: ++idCounter, num: tr.takeSeq, name: name || ('Take ' + tr.takeSeq), buffer, peaks: null, offset: Math.max(0, offset || 0), trimStart: 0, trimEnd: buffer.duration, createdAt: new Date() };
  tr.takes.push(t); tr.activeTakeId = t.id;
  return t;
}
function setActiveTake(tr, takeId) { pushUndo(); tr.activeTakeId = takeId; renderTrack(tr); updateSelectionUI(); renderTakesWindow(); layout(); }
function removeTake(tr, takeId) {
  pushUndo();
  tr.takes = tr.takes.filter((t) => t.id !== takeId);
  if (tr.activeTakeId === takeId) tr.activeTakeId = tr.takes.length ? tr.takes[tr.takes.length - 1].id : null;
  renderTrack(tr); layout(); renderTakesWindow();
}

// ===========================================================================
// Track DOM (one clip element per track for its active take)
// ===========================================================================
function buildTracksDOM() {
  el.trackLabels.innerHTML = ''; el.trackLanes.innerHTML = '';
  state.tracks.forEach((tr) => {
    const label = document.createElement('div');
    label.className = 'lane-label track'; label.style.setProperty('--tc', tr.color);
    label.innerHTML = `<div class="ll-row"><span class="swatch"></span><span class="ll-title"></span><span class="ll-rec hidden"><span class="dot"></span>REC</span></div>
      <div class="ll-ctrls">
        <button class="ll-btn mute" data-title="Mute" data-tip="এই ট্র্যাক মিউট করুন।">M</button>
        <button class="ll-btn solo" data-title="Solo" data-tip="শুধু এই ট্র্যাক শুনুন।">S</button>
        <input type="range" class="track-vol slider" min="0" max="1" step="0.01" data-title="Track Volume" data-tip="এই ট্র্যাকের ভলিউম।" />
      </div>`;
    label.querySelector('.swatch').style.background = tr.color;
    label.querySelector('.ll-title').textContent = tr.name;
    const muteBtn = label.querySelector('.mute'); muteBtn.classList.toggle('on', !!tr.muted);
    muteBtn.addEventListener('click', (e) => { e.stopPropagation(); setMute(tr, !tr.muted); });
    const soloBtn = label.querySelector('.solo'); soloBtn.classList.toggle('on', !!tr.soloed);
    soloBtn.addEventListener('click', (e) => { e.stopPropagation(); setSolo(tr, !tr.soloed); });
    const volInput = label.querySelector('.track-vol');
    volInput.value = tr.volume == null ? 1 : tr.volume;
    volInput.addEventListener('input', () => { tr.volume = parseFloat(volInput.value); applyTrackGains(); markDirty(); });
    styleRange(volInput);
    label.addEventListener('click', () => selectTrack(tr.id));
    label.addEventListener('contextmenu', (e) => { e.preventDefault(); selectTrack(tr.id); showTrackMenu(e, tr); });

    const body = document.createElement('div');
    body.className = 'lane-body track'; body.dataset.track = tr.id; body.style.setProperty('--tc', tr.color);
    const clip = document.createElement('div');
    clip.className = 'clip hidden';
    clip.setAttribute('data-title', 'Audio Clip');
    clip.setAttribute('data-tip', 'মাঝখান টেনে সরান; দুই প্রান্ত টেনে ছোট/বড় করুন। ডান-ক্লিকে অপশন।');
    const trimL = document.createElement('div'); trimL.className = 'trim left';
    const trimR = document.createElement('div'); trimR.className = 'trim right';
    const canvas = document.createElement('canvas');
    const clipLabel = document.createElement('div'); clipLabel.className = 'clip-label';
    clip.appendChild(trimL); clip.appendChild(canvas); clip.appendChild(trimR); clip.appendChild(clipLabel);
    body.appendChild(clip);

    el.trackLabels.appendChild(label); el.trackLanes.appendChild(body);
    tr.els = { label, body, clip, canvas, trimL, trimR, clipLabel, title: label.querySelector('.ll-title'), rec: label.querySelector('.ll-rec') };
    tr.els.title.addEventListener('dblclick', (e) => { e.stopPropagation(); startRename(tr); });

    body.addEventListener('pointerdown', (e) => { if (e.button !== 0 || e.target.closest('.clip')) return; selectTrack(tr.id); timelineDown(e); });
    body.addEventListener('contextmenu', (e) => { if (e.target.closest('.clip')) return; e.preventDefault(); selectTrack(tr.id); showTrackMenu(e, tr); });
    clip.addEventListener('pointerdown', (e) => { if (e.button !== 0 || e.target.closest('.trim')) return; e.stopPropagation(); const tk = activeTake(tr); if (tk) moveTake(e, tr, tk); });
    trimL.addEventListener('pointerdown', (e) => { if (e.button !== 0) return; e.stopPropagation(); const tk = activeTake(tr); if (tk) trimTake(e, tr, tk, 'l'); });
    trimR.addEventListener('pointerdown', (e) => { if (e.button !== 0) return; e.stopPropagation(); const tk = activeTake(tr); if (tk) trimTake(e, tr, tk, 'r'); });
    clip.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); selectTrack(tr.id); showTrackMenu(e, tr); });

    renderTrack(tr);
  });
  updateSelectionUI(); updatePlayheadHeight();
}
function renderTrack(tr) {
  if (!tr.els) return;
  const { clip, canvas, title } = tr.els;
  title.textContent = tr.name;
  if (state.recording && state.recTrackId === tr.id) { clip.classList.add('hidden'); return; }
  const tk = activeTake(tr);
  if (!tk) { clip.classList.add('hidden'); return; }
  clip.classList.remove('hidden');
  tr.els.clipLabel.textContent = tk.name || ('Take ' + tk.num);
  const vd = visDur(tk), w = Math.max(4, Math.round(vd * PPS));
  clip.style.left = Math.round(tk.offset * PPS) + 'px'; clip.style.width = w + 'px';
  clip.style.borderColor = tr.color; clip.style.background = 'color-mix(in srgb, ' + tr.color + ' 22%, #223230)';
  if (!tk.peaks) tk.peaks = computePeaks(tk.buffer, PPS);
  drawPeaksRange(canvas, tk.peaks, WAVE_H, tr.color, Math.floor(tk.trimStart * PPS), Math.ceil(tk.trimEnd * PPS));
  canvas.style.width = w + 'px'; canvas.style.height = WAVE_H + 'px';
}
function updateSelectionUI() {
  state.tracks.forEach((tr) => {
    if (!tr.els) return;
    const sel = tr.id === state.selectedTrackId;
    tr.els.label.classList.toggle('selected', sel);
    tr.els.body.classList.toggle('selected', sel);
    tr.els.rec.classList.toggle('hidden', !sel);
  });
}
function updatePlayheadHeight() { el.playhead.style.height = (RULER_H + state.tracks.length * TRACK_H) + 'px'; }

// ---- clip interactions (active take) ----
function moveTake(e, tr, tk) {
  selectTrack(tr.id); pushUndo();
  const d = { x: e.clientX, off: tk.offset };
  const move = (ev) => { tk.offset = Math.max(0, d.off + (ev.clientX - d.x) / PPS); renderTrack(tr); renderPlayhead(); };
  const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); layout(); };
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
}
function trimTake(e, tr, tk, side) {
  selectTrack(tr.id); pushUndo();
  const d = { x: e.clientX, ts: tk.trimStart, te: tk.trimEnd, off: tk.offset };
  const move = (ev) => {
    const dx = (ev.clientX - d.x) / PPS;
    if (side === 'l') { let nts = Math.min(Math.max(0, d.ts + dx), tk.trimEnd - 0.05); const ap = nts - d.ts; tk.trimStart = nts; tk.offset = Math.max(0, d.off + ap); }
    else { tk.trimEnd = Math.min(tk.buffer.duration, Math.max(tk.trimStart + 0.05, d.te + dx)); }
    renderTrack(tr); renderPlayhead();
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
    addTake(tr, buf, state.playhead, res.name.replace(/\.[^.]+$/, ''));
    selectTrack(tr.id); renderTrack(tr); layout(); renderTakesWindow();
    showToast(`Loaded into ${tr.name}`);
  } catch (e) { console.error(e); showToast('Could not decode that file'); }
}
function loadIntoSelected() { let tr = selectedTrack(); if (!tr) tr = addTrack(true); loadFileInto(tr); }

// ===========================================================================
// Context menu
// ===========================================================================
function menuItem(m, label, fn, cls) { const it = document.createElement('div'); it.className = 'ctx-item' + (cls ? ' ' + cls : ''); it.textContent = label; it.onclick = () => { hideCtx(); fn(); }; m.appendChild(it); }
function showTrackMenu(e, tr) {
  const m = el.ctxMenu; m.innerHTML = '';
  menuItem(m, 'Rename track', () => startRename(tr));
  menuItem(m, 'Load audio into track…', () => loadFileInto(tr));
  if (activeTake(tr)) menuItem(m, 'Remove current take', () => removeTake(tr, tr.activeTakeId));
  const sep = document.createElement('div'); sep.className = 'ctx-sep'; m.appendChild(sep);
  if (state.tracks.length <= 1) menuItem(m, 'Delete track', () => showToast("Can't delete the only track"), 'danger disabled');
  else menuItem(m, 'Delete track', () => deleteTrack(tr.id), 'danger');
  m.classList.remove('hidden');
  const mw = m.offsetWidth, mh = m.offsetHeight;
  m.style.left = Math.min(e.clientX, window.innerWidth - mw - 6) + 'px';
  m.style.top = Math.min(e.clientY, window.innerHeight - mh - 6) + 'px';
}
function hideCtx() { el.ctxMenu.classList.add('hidden'); }

// ===========================================================================
// Timeline sizing / rendering
// ===========================================================================
function contentDuration() {
  let d = 0;
  state.tracks.forEach((tr) => { const tk = activeTake(tr); if (tk) d = Math.max(d, tk.offset + visDur(tk)); });
  if (state.recording) d = Math.max(d, state.playhead + 1);
  // Always fill at least the visible width (so zooming out reveals more time),
  // plus some headroom past the content, and never less than MIN_DURATION.
  const viewSecs = (el.timelineScroll.clientWidth || 900) / PPS;
  return Math.max(d + 4, viewSecs, MIN_DURATION);
}
function invalidatePeaks() { state.tracks.forEach((tr) => tr.takes.forEach((t) => (t.peaks = null))); }
function layout() {
  const px = Math.ceil(contentDuration() * PPS);
  el.timeline.style.width = px + 'px'; el.rulerCanvas.style.width = px + 'px';
  drawRuler(px); drawGrid(px);
  if (!state.recording) state.tracks.forEach(renderTrack);
  updatePlayheadHeight();
  renderPlayhead();
}
function drawRuler(px) {
  const c = el.rulerCanvas, h = RULER_H; c.width = px; c.height = h;
  const g = c.getContext('2d'); g.fillStyle = '#1c2628'; g.fillRect(0, 0, px, h);
  g.font = "10px 'Lato', sans-serif"; g.lineWidth = 1; g.textBaseline = 'middle';
  const beats = bpb(), beatDur = 60 / state.bpm, barDur = beats * beatDur;
  const barPx = barDur * PPS, beatPx = beatDur * PPS;
  const totalBeats = Math.ceil(px / beatPx) + 1;
  const labelBeats = beatPx >= 46;                 // room to label every beat "bar.beat"
  let barEvery = 1; if (!labelBeats && barPx < 26) barEvery = Math.ceil(26 / barPx);
  for (let gb = 0; gb <= totalBeats; gb++) {
    const x = Math.round(gb * beatPx) + 0.5;
    const isBar = gb % beats === 0;
    const bar = Math.floor(gb / beats) + 1, beat = (gb % beats) + 1;
    if (isBar || beatPx >= 9) {                     // skip beat ticks when too dense
      g.strokeStyle = isBar ? '#4a5f57' : '#39473f';
      g.beginPath(); g.moveTo(x, h - (isBar ? 15 : 8)); g.lineTo(x, h); g.stroke();
    }
    if (labelBeats) {
      g.fillStyle = isBar ? '#9fb28f' : '#6f8074';
      g.textAlign = gb === 0 ? 'left' : 'center';
      g.fillText(bar + '.' + beat, gb === 0 ? x + 4 : x, 9);
    } else if (isBar && ((bar - 1) % barEvery === 0)) {
      g.fillStyle = '#8fa596';
      g.textAlign = gb === 0 ? 'left' : 'center';
      g.fillText(String(bar), gb === 0 ? x + 4 : x, 9);
    }
  }
  g.textAlign = 'left'; g.textBaseline = 'alphabetic';
}
function drawGrid(px) {
  const c = el.gridCanvas, h = Math.max(1, state.tracks.length * TRACK_H);
  c.width = px; c.height = h; c.style.width = px + 'px'; c.style.height = h + 'px';
  const g = c.getContext('2d');
  g.fillStyle = '#1a2325'; g.fillRect(0, 0, px, h);
  const beats = bpb(), beatDur = 60 / state.bpm, barDur = beats * beatDur;
  const barPx = barDur * PPS, beatPx = beatDur * PPS;
  // faint alternate-bar shading
  g.fillStyle = 'rgba(255,255,255,.014)';
  for (let bar = 0; bar <= Math.ceil(px / barPx); bar++) if (bar % 2 === 1) g.fillRect(Math.round(bar * barPx), 0, Math.max(1, Math.round(barPx)), h);
  // finest subdivision (per beat) chosen by zoom: 64th → 32nd → 16th → 8th → beat → bars
  let div = 0;
  if (beatPx >= 12) div = 1; if (beatPx / 2 >= 14) div = 2; if (beatPx / 4 >= 14) div = 4;
  if (beatPx / 8 >= 14) div = 8; if (beatPx / 16 >= 14) div = 16;
  g.lineWidth = 1;
  if (div >= 1) {
    const subPx = beatPx / div, totalSubs = Math.ceil(px / subPx) + 1;
    for (let i = 0; i <= totalSubs; i++) {
      const x = Math.round(i * subPx) + 0.5, isBeat = i % div === 0, isBar = isBeat && (Math.round(i / div) % beats === 0);
      g.strokeStyle = isBar ? 'rgba(190,205,175,.16)' : isBeat ? 'rgba(170,190,160,.09)' : 'rgba(150,170,150,.045)';
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke();
    }
  } else {
    const totalBars = Math.ceil(px / barPx) + 1;
    g.strokeStyle = 'rgba(190,205,175,.14)';
    for (let bar = 0; bar <= totalBars; bar++) { const x = Math.round(bar * barPx) + 0.5; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); }
  }
}
function refreshRuler() { const px = Math.ceil(contentDuration() * PPS); drawRuler(px); drawGrid(px); }
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
  scheduleFlash(time, accent);
}
function scheduleFlash(time, accent) { const delay = Math.max(0, (time - state.ctx.currentTime) * 1000); setTimeout(() => pulseMetro(accent), delay); }
function pulseMetro(accent) {
  const b = el.metroBtn;
  b.classList.remove('beat1', 'beat'); void b.offsetWidth;
  b.classList.add(accent ? 'beat1' : 'beat');
  clearTimeout(b._pt); b._pt = setTimeout(() => b.classList.remove('beat1', 'beat'), 210);
}
function scheduler() {
  const c = state.ctx;
  while (state.nextNoteTime < c.currentTime + 0.12) {
    const beatInBar = state.beatCounter % bpb(), countin = state.countInLeft > 0;
    if (countin || state.metronomeOn) click(state.nextNoteTime, beatInBar === 0, countin);
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

// Metronome during playback — clicks aligned to the timeline grid, gated by the toggle.
let metroTimer = null, metroBeat = 0;
function startMetroPlayback() {
  stopMetroPlayback();
  if (!state.metronomeOn || !state.playing) return;
  const sb = spb();
  metroBeat = Math.max(0, Math.ceil(state.playStartHead / sb - 1e-6));
  const tick = () => {
    if (!state.playing) { stopMetroPlayback(); return; }
    const now = state.ctx.currentTime, sbb = spb();
    while (true) {
      const T = metroBeat * sbb, ctxT = state.playStartCtx + (T - state.playStartHead);
      if (ctxT > now + 0.2) break;
      if (ctxT >= now - 0.03) { const bib = ((metroBeat % bpb()) + bpb()) % bpb(); click(ctxT, bib === 0, false); }
      metroBeat++;
    }
    metroTimer = setTimeout(tick, 25);
  };
  tick();
}
function stopMetroPlayback() { if (metroTimer) { clearTimeout(metroTimer); metroTimer = null; } }

// ===========================================================================
// Playback
// ===========================================================================
function stopSources() { state.playSources.forEach((s) => { try { s.stop(); } catch (_) {} }); state.playSources = []; }
function scheduleTake(tr, tk, head, ctxStart) {
  const start = tk.offset, vd = visDur(tk), end = start + vd;
  if (end <= head) return;
  const s = state.ctx.createBufferSource(); s.buffer = tk.buffer; s.connect(trackGain(tr));
  if (head <= start) s.start(ctxStart + (start - head), tk.trimStart, vd);
  else { const into = head - start; s.start(ctxStart, tk.trimStart + into, vd - into); }
  state.playSources.push(s);
}
function scheduleAll(head, ctxStart, exceptTrackId) {
  state.tracks.forEach((tr) => { if (tr.id === exceptTrackId) return; const tk = activeTake(tr); if (tk) scheduleTake(tr, tk, head, ctxStart); });
}
function startPlayback() {
  const c = ctx(); applyOutput(); stopSources();
  const ctxStart = c.currentTime + 0.06; state.playStartCtx = ctxStart; state.playStartHead = state.playhead;
  scheduleAll(state.playhead, ctxStart, null);
  state.playing = true; updatePlayIcon(); startMetroPlayback(); tickPlayhead();
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
  state.playing = false; stopSources(); stopMetroPlayback(); if (state.raf) cancelAnimationFrame(state.raf); updatePlayIcon(); renderPlayhead();
}
function seek(seconds, keepPlaying) { state.playhead = Math.max(0, Math.min(seconds, contentDuration())); if (state.playing && keepPlaying) { stopSources(); startPlayback(); } renderPlayhead(); }
function updatePlayIcon() { el.playPauseBtn.innerHTML = state.playing ? ICON_PAUSE : ICON_PLAY; el.playPauseBtn.classList.toggle('playing', state.playing); }

// ===========================================================================
// Recording
// ===========================================================================
async function beginRecording(editing) {
  if (state.recording) return;
  let tr = selectedTrack(); if (!tr) tr = addTrack(true);
  if (editing && !activeTake(tr)) editing = false;
  ctx(); await applyOutput();
  try { await openInput(); } catch (e) { console.error(e); showToast('Cannot open input device'); return; }

  state.recording = true; state.editing = editing; state.recTrackId = tr.id;
  state.recStartHead = state.playhead; state.livePeaks = []; state.recEl = null;
  el.recordBtn.classList.add('armed');
  tr.els.clip.classList.add('hidden');
  const countInBars = parseInt(el.countIn.value, 10) || 0;
  showToast(countInBars ? 'Counting in…' : `Recording into ${tr.name}…`);
  const onDown = (downCtxTime) => {
    const delay = Math.max(0, (downCtxTime - state.ctx.currentTime) * 1000);
    setTimeout(() => {
      if (!state.recording) return;
      // Create the live recording clip only now (not during the count-in).
      const recEl = document.createElement('div'); recEl.className = 'clip rec-temp recording';
      const canvas = document.createElement('canvas'); recEl.appendChild(canvas); tr.els.body.appendChild(recEl);
      state.recEl = { recEl, canvas };
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
  el.timeline.style.width = px + 'px'; el.rulerCanvas.style.width = px + 'px'; drawRuler(px); drawGrid(px);
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
  if (!state.recChunks || !state.recChunks.length) { if (tr) renderTrack(tr); showToast('Nothing captured'); return; }
  const blob = new Blob(state.recChunks, { type: state.recorder.mimeType });
  let recBuf; try { recBuf = await ctx().decodeAudioData((await blob.arrayBuffer()).slice(0)); } catch (e) { console.error('decode', e); showToast('Decode failed'); return; }
  if (!tr) return;
  pushUndo();
  const act = activeTake(tr);
  if (editing && act) {
    const keep = Math.max(0, state.recStartHead - act.offset);
    act.buffer = concatBuffers(ctx(), act.buffer, keep, recBuf); act.trimStart = 0; act.trimEnd = act.buffer.duration; act.peaks = null;
    showToast(`Overdubbed ${tr.name} · Take ${act.num}`);
  } else {
    const tk = addTake(tr, recBuf, state.recStartHead);
    showToast(`${tr.name} · Take ${tk.num} recorded`);
  }
  state.playhead = state.recStartHead; renderTrack(tr); layout(); renderTakesWindow();
}
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
// Takes drawer (selected track's takes; one active)
// ===========================================================================
function renderTakesWindow() {
  const tr = selectedTrack();
  el.tpTrack.textContent = tr ? tr.name : '';
  el.tpBody.innerHTML = '';
  if (!tr || !tr.takes.length) { el.tpBody.innerHTML = '<div class="tw-empty">No takes on this track yet.</div>'; return; }
  [...tr.takes].sort((a, b) => b.num - a.num).forEach((take) => {
    const item = document.createElement('div');
    item.className = 'take-item' + (take.id === tr.activeTakeId ? ' current' : '');
    item.setAttribute('data-title', 'Take'); item.setAttribute('data-tip', 'ক্লিক করে এই টেকটি ট্র্যাকে দেখান।');
    item.innerHTML = `
      <div class="take-num">#${take.num}</div>
      <div class="take-mini"><canvas></canvas><div class="take-meta">${take.name || ('Take ' + take.num)} · ${fmt(visDur(take))}</div></div>
      <div class="take-ctrls">
        <button data-a="wav" data-title="Export WAV" data-tip="লসলেস WAV হিসেবে সেভ করুন।">WAV</button>
        <button data-a="mp3" data-title="Export MP3" data-tip="১৯২ kbps MP3 হিসেবে সেভ করুন।">MP3</button>
        <button data-a="del" class="icon-only" data-title="Delete" data-tip="এই টেকটি মুছে ফেলুন।">${SVG_TRASH}</button>
      </div>`;
    item.onclick = (e) => { if (!e.target.closest('button')) setActiveTake(tr, take.id); };
    item.querySelector('[data-a="wav"]').onclick = () => exportTake(take, 'wav', tr);
    item.querySelector('[data-a="mp3"]').onclick = () => exportTake(take, 'mp3', tr);
    item.querySelector('[data-a="del"]').onclick = () => removeTake(tr, take.id);
    el.tpBody.appendChild(item);
    if (!take.peaks) take.peaks = computePeaks(take.buffer, PPS);
    requestAnimationFrame(() => drawMini(item.querySelector('canvas'), take.peaks, tr.color));
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
function trimmedBuffer(tk) {
  const b = tk.buffer, sr = b.sampleRate;
  const s = Math.floor(tk.trimStart * sr), e = Math.min(b.length, Math.floor(tk.trimEnd * sr));
  const len = Math.max(1, e - s), out = ctx().createBuffer(b.numberOfChannels, len, sr);
  for (let ch = 0; ch < b.numberOfChannels; ch++) { const src = b.getChannelData(ch), dst = out.getChannelData(ch); for (let i = 0; i < len; i++) dst[i] = src[s + i] || 0; }
  return out;
}
async function exportTake(take, format, tr) {
  showToast(`Exporting ${format.toUpperCase()}…`);
  const buf = trimmedBuffer(take);
  const bytes = format === 'wav' ? encodeWav(buf) : encodeMp3(buf);
  const base = `${(tr ? tr.name : 'Take').replace(/\s+/g, '_')}_take${take.num}`;
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
// Project management (save / open / new)
// ===========================================================================
function u8ToBase64(u8) { let s = ''; const chunk = 0x8000; for (let i = 0; i < u8.length; i += chunk) s += String.fromCharCode.apply(null, u8.subarray(i, i + chunk)); return btoa(s); }
function base64ToU8(b64) { const s = atob(b64), u8 = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i); return u8; }
function updateTitle() { document.title = 'Dawzer — ' + (state.projectName || 'Untitled'); }
function serializeProject() {
  return {
    app: 'dawzer', version: 1,
    bpm: state.bpm, beatsPerBar: el.beatsPerBar.value, countIn: el.countIn.value, clickVol: el.clickVol.value, metronomeOn: state.metronomeOn,
    trackSeq: state.trackSeq, selectedIndex: state.tracks.findIndex((t) => t.id === state.selectedTrackId),
    tracks: state.tracks.map((tr) => ({
      name: tr.name, color: tr.color, volume: tr.volume, muted: tr.muted, soloed: tr.soloed,
      takeSeq: tr.takeSeq, activeTakeNum: (activeTake(tr) ? activeTake(tr).num : null),
      takes: tr.takes.map((tk) => ({ num: tk.num, name: tk.name, offset: tk.offset, trimStart: tk.trimStart, trimEnd: tk.trimEnd,
        createdAt: (tk.createdAt instanceof Date ? tk.createdAt.toISOString() : tk.createdAt), wav: u8ToBase64(encodeWav(tk.buffer)) })),
    })),
  };
}
async function confirmDiscard() {
  if (!state.dirty) return 'discard';
  const r = await ipcRenderer.invoke('confirm-unsaved');
  return ['save', 'discard', 'cancel'][r] || 'cancel';
}
async function saveProject() {
  showToast('Saving…');
  const bytes = new TextEncoder().encode(JSON.stringify(serializeProject()));
  const res = await ipcRenderer.invoke('save-project', { defaultName: (state.projectName || 'Untitled') + '.dz', data: bytes });
  if (res.ok) { state.projectName = res.name.replace(/\.dz$/i, ''); updateTitle(); clearDirty(); showToast('Project saved'); }
  else showToast('Save cancelled');
}
async function openProject() {
  const c = await confirmDiscard(); if (c === 'cancel') return;
  if (c === 'save') { await saveProject(); if (state.dirty) return; }
  const res = await ipcRenderer.invoke('open-project');
  if (!res.ok) return;
  try {
    const p = JSON.parse(new TextDecoder().decode(new Uint8Array(res.data)));
    await loadProject(p);
    state.projectName = res.name.replace(/\.dz$/i, ''); updateTitle(); clearDirty();
    showToast('Project opened');
  } catch (e) { console.error(e); showToast('Could not open project'); }
}
async function loadProject(p) {
  const c = ctx();
  if (p.bpm) setBpm(p.bpm);
  if (p.beatsPerBar) el.beatsPerBar.value = p.beatsPerBar;
  if (p.countIn != null) el.countIn.value = p.countIn;
  if (p.clickVol != null) { el.clickVol.value = p.clickVol; styleRange(el.clickVol); }
  state.metronomeOn = p.metronomeOn !== false; el.metroBtn.classList.toggle('active', state.metronomeOn);
  state.trackSeq = p.trackSeq || (p.tracks ? p.tracks.length : 0);
  const tracks = [];
  for (const t of (p.tracks || [])) {
    const tr = { id: ++idCounter, name: t.name, color: t.color, volume: t.volume == null ? 1 : t.volume, muted: !!t.muted, soloed: !!t.soloed, takeSeq: t.takeSeq || (t.takes ? t.takes.length : 0), activeTakeId: null, gainNode: null, els: null, takes: [] };
    for (const tk of (t.takes || [])) {
      let buf; try { buf = await c.decodeAudioData(base64ToU8(tk.wav).buffer.slice(0)); } catch (e) { console.warn('take decode', e); continue; }
      const take = { id: ++idCounter, num: tk.num, name: tk.name || ('Take ' + tk.num), buffer: buf, peaks: null, offset: tk.offset || 0, trimStart: tk.trimStart || 0, trimEnd: tk.trimEnd != null ? tk.trimEnd : buf.duration, createdAt: tk.createdAt ? new Date(tk.createdAt) : new Date() };
      tr.takes.push(take);
      if (tk.num === t.activeTakeNum) tr.activeTakeId = take.id;
    }
    if (!tr.activeTakeId && tr.takes.length) tr.activeTakeId = tr.takes[tr.takes.length - 1].id;
    tracks.push(tr);
  }
  state.tracks = tracks;
  if (!state.tracks.length) { addTrack(true); addTrack(true); }
  state.selectedTrackId = state.tracks[Math.max(0, Math.min(state.tracks.length - 1, p.selectedIndex || 0))].id;
  state.undoStack = []; state.redoStack = []; state.playhead = 0;
  buildTracksDOM(); layout(); renderTakesWindow();
}
async function newProject() {
  const c = await confirmDiscard(); if (c === 'cancel') return;
  if (c === 'save') { await saveProject(); if (state.dirty) return; }
  if (state.recording) stopRecording(); if (state.playing) pausePlayback();
  state.tracks = []; state.trackSeq = 0; state.selectedTrackId = null; state.undoStack = []; state.redoStack = []; state.playhead = 0;
  addTrack(true); addTrack(true); state.selectedTrackId = state.tracks[0].id;
  state.projectName = 'Untitled'; updateTitle();
  buildTracksDOM(); layout(); renderTakesWindow(); clearDirty(); showToast('New project');
}
function showProjectMenu(e) {
  const m = el.ctxMenu; m.innerHTML = '';
  menuItem(m, 'New project', () => newProject());
  menuItem(m, 'Open project…', () => openProject());
  menuItem(m, 'Save project…', () => saveProject());
  m.classList.remove('hidden');
  const mw = m.offsetWidth, mh = m.offsetHeight, r = e.currentTarget.getBoundingClientRect();
  m.style.left = Math.min(r.left, window.innerWidth - mw - 6) + 'px';
  m.style.top = Math.min(r.bottom + 4, window.innerHeight - mh - 6) + 'px';
}

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
  if (state.recording || e.target.closest('.clip')) return;
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

// Fills a range slider's track up to its value via the --p CSS variable.
function styleRange(input) {
  const min = parseFloat(input.min) || 0, max = parseFloat(input.max) || 1;
  const upd = () => input.style.setProperty('--p', (((parseFloat(input.value) - min) / (max - min)) * 100) + '%');
  upd(); input.addEventListener('input', upd);
}

// ===========================================================================
// BPM control
// ===========================================================================
function setBpm(v) { state.bpm = Math.min(300, Math.max(30, Math.round(v))); el.bpmValue.textContent = state.bpm; refreshRuler(); }
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
el.metroBtn.onclick = () => {
  state.metronomeOn = !state.metronomeOn;
  el.metroBtn.classList.toggle('active', state.metronomeOn);
  if (state.playing) { state.metronomeOn ? startMetroPlayback() : stopMetroPlayback(); }
  showToast(state.metronomeOn ? 'Metronome on' : 'Metronome off');
};
el.recordBtn.onclick = () => { if (state.recording) stopRecording(); else beginRecording(state.editMode); };
el.editBtn.onclick = () => { state.editMode = !state.editMode; el.editBtn.classList.toggle('editon', state.editMode); showToast(state.editMode ? 'Edit mode ON — Record overdubs the current take' : 'Edit mode off'); };
el.playPauseBtn.onclick = () => { state.playing ? pausePlayback() : startPlayback(); };
el.stopBtn.onclick = () => { if (state.recording) stopRecording(); else { pausePlayback(); seek(0, false); } };
el.takesBtn.onclick = () => toggleTakesWindow();
el.tpHeader.onclick = () => toggleTakesWindow();
el.projectBtn.onclick = (e) => showProjectMenu(e);
el.testBtn.onclick = testOutput;
el.addTrackBtn.onclick = userAddTrack;
el.addTrackRow.onclick = userAddTrack;
el.loadBackingBtn.onclick = loadIntoSelected;
function openSettings() { el.settingsModal.classList.remove('hidden'); el.settingsBtn.classList.add('active'); }
function closeSettings() { el.settingsModal.classList.add('hidden'); el.settingsBtn.classList.remove('active'); }
el.settingsBtn.onclick = () => { el.settingsModal.classList.contains('hidden') ? openSettings() : closeSettings(); };
el.settingsClose.onclick = closeSettings;
el.settingsBackdrop.onclick = closeSettings;
el.refreshDevices.onclick = listDevices;
el.inputDevice.onchange = () => (state.inputDeviceId = el.inputDevice.value);
el.outputDevice.onchange = () => { state.outputDeviceId = el.outputDevice.value; applyOutput(); };
el.monitorToggle.onchange = () => { state.monitor = el.monitorToggle.checked; if (state.monitorGain) state.monitorGain.gain.value = state.monitor ? 1 : 0; };
el.langSelect.onchange = () => { state.lang = el.langSelect.value; showToast(state.lang === 'bn' ? 'ভাষা: বাংলা' : 'Language: English'); };
el.beatsPerBar.onchange = () => refreshRuler();
styleRange(el.clickVol);

holdRepeat(el.bpmUp, +1); holdRepeat(el.bpmDown, -1); initBpmDrag();

el.rulerCanvas.addEventListener('pointerdown', timelineDown);
el.timelineScroll.addEventListener('wheel', (e) => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); setZoom(PPS * Math.exp(-e.deltaY * 0.004), e.clientX); } }, { passive: false });

document.addEventListener('keydown', (e) => {
  if (e.code === 'Escape' && !el.settingsModal.classList.contains('hidden')) { closeSettings(); return; }
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.code === 'KeyZ') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && e.code === 'KeyY') { e.preventDefault(); redo(); return; }
  if (mod && e.code === 'KeyS') { e.preventDefault(); saveProject(); return; }
  if (mod && e.code === 'KeyO') { e.preventDefault(); openProject(); return; }
  if (mod && e.code === 'KeyN') { e.preventDefault(); newProject(); return; }
  if (mod) return;
  if (e.repeat) return;
  if (e.code === 'Space') { e.preventDefault(); if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); if (state.recording) stopRecording(); else state.playing ? pausePlayback() : startPlayback(); }
  else if (e.code === 'KeyR') { e.preventDefault(); if (state.recording) stopRecording(); else beginRecording(state.editMode); }
  else if (e.code === 'KeyT') { e.preventDefault(); toggleTakesWindow(); }
  else if (e.code === 'KeyM') { e.preventDefault(); const tr = selectedTrack(); if (tr) setMute(tr, !tr.muted); }
  else if (e.code === 'KeyS') { e.preventDefault(); const tr = selectedTrack(); if (tr) setSolo(tr, !tr.soloed); }
});

// Unsaved-changes guard on window close.
ipcRenderer.on('app-close-request', async () => {
  const c = await confirmDiscard();
  if (c === 'cancel') return;
  if (c === 'save') { await saveProject(); if (state.dirty) return; }
  ipcRenderer.send('do-close');
});

// Init
setBpm(100); updatePlayIcon(); updateTitle();
el.metroBtn.classList.toggle('active', state.metronomeOn);
addTrack(true); addTrack(true); state.selectedTrackId = state.tracks[0].id;
buildTracksDOM(); layout(); renderTakesWindow(); listDevices(); clearDirty();
navigator.mediaDevices.addEventListener('devicechange', listDevices);
window.addEventListener('resize', () => { layout(); renderTakesWindow(); });
setTimeout(() => el.splash && el.splash.classList.add('hide'), 1150);
