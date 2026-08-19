// ===========================================================
// Reelwright — core editor
// Everything runs client-side. The only network calls are
// one-time, lazy CDN fetches of FFmpeg / Whisper the first
// time you click Export or Generate captions.
// ===========================================================

const state = {
  file: null,
  isAudioOnly: false,
  duration: 0,
  inPoint: 0,
  outPoint: 0,
  peaks: null,        // Float32Array pairs [min,max,min,max,...] at fixed resolution
  peaksResolution: 2000,
  dragging: null,      // 'in' | 'out' | 'scrub' | null
  looping: false,
  transcript: null,    // { chunks, vtt, srt } once generated
};

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);

const dropzone = $('dropzone');
const fileInput = $('fileInput');
const editor = $('editor');
const video = $('preview');
const audioOnlyBadge = $('audioOnlyBadge');

const playBtn = $('playBtn');
const playIcon = $('playIcon');
const pauseIcon = $('pauseIcon');
const toInBtn = $('toInBtn');
const toOutBtn = $('toOutBtn');
const loopToggle = $('loopToggle');
const timeReadout = $('timeReadout');

const canvas = $('timeline');
const ctx = canvas.getContext('2d');
const waveformStatus = $('waveformStatus');

const inField = $('inField');
const outField = $('outField');
const selLength = $('selLength');
const setInBtn = $('setInBtn');
const setOutBtn = $('setOutBtn');
const qualitySelect = $('qualitySelect');
const embedCaptionsRow = $('embedCaptionsRow');
const embedCaptionsToggle = $('embedCaptionsToggle');
const exportBtn = $('exportBtn');
const exportStatus = $('exportStatus');
const exportProgressBar = $('exportProgressBar');
const exportStatusText = $('exportStatusText');
const exportDownload = $('exportDownload');

const tabs = document.querySelectorAll('.tab');
const panelTrim = $('panel-trim');
const panelCaptions = $('panel-captions');

const modelSelect = $('modelSelect');
const transcribeBtn = $('transcribeBtn');
const transcribeStatus = $('transcribeStatus');
const transcribeProgressBar = $('transcribeProgressBar');
const transcribeStatusText = $('transcribeStatusText');
const transcriptPanel = $('transcriptPanel');
const transcriptList = $('transcriptList');
const downloadSrtBtn = $('downloadSrtBtn');
const downloadVttBtn = $('downloadVttBtn');

// ---------- Time helpers ----------

function formatTimecode(totalSeconds) {
  const s = Math.max(0, totalSeconds || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const ms = Math.round((s - Math.floor(s)) * 1000);
  const pad = (n, l = 2) => String(n).padStart(l, '0');
  return `${pad(h)}:${pad(m)}:${pad(sec)}.${pad(ms, 3)}`;
}

function parseTimecode(str) {
  const parts = String(str).trim().split(':');
  if (parts.length !== 3) return NaN;
  const h = parseFloat(parts[0]);
  const m = parseFloat(parts[1]);
  const s = parseFloat(parts[2]);
  if ([h, m, s].some((n) => Number.isNaN(n))) return NaN;
  return h * 3600 + m * 60 + s;
}

// ---------- File loading ----------

['dragenter', 'dragover'].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.add('drag-over');
  })
);
['dragleave', 'drop'].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.remove('drag-over');
  })
);
dropzone.addEventListener('drop', (e) => {
  const f = e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) loadFile(f);
});
// Also allow dropping anywhere on the page once the editor is open
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  if (editor.hidden) return;
  e.preventDefault();
  const f = e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) loadFile(f);
});

fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) loadFile(fileInput.files[0]);
});

function loadFile(file) {
  state.file = file;
  state.isAudioOnly = file.type.startsWith('audio/');
  state.transcript = null;
  transcriptPanel.hidden = true;
  embedCaptionsRow.hidden = true;
  exportDownload.hidden = true;
  exportStatus.hidden = true;

  const url = URL.createObjectURL(file);
  video.src = url;
  audioOnlyBadge.hidden = !state.isAudioOnly;

  dropzone.hidden = true;
  editor.hidden = false;

  video.addEventListener('loadedmetadata', onMetadataLoaded, { once: true });
  decodeWaveform(file);
}

function onMetadataLoaded() {
  state.duration = video.duration || 0;
  state.inPoint = 0;
  state.outPoint = state.duration;
  syncFieldsFromState();
  resizeCanvas();
  drawTimeline();
}

// ---------- Waveform decoding ----------

async function decodeWaveform(file) {
  waveformStatus.hidden = false;
  waveformStatus.textContent = 'Decoding waveform…';
  try {
    const arrayBuffer = await file.arrayBuffer();
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const actx = new AudioCtx();
    const audioBuffer = await actx.decodeAudioData(arrayBuffer);
    state.peaks = computePeaks(audioBuffer, state.peaksResolution);
    waveformStatus.hidden = true;
    actx.close();
  } catch (err) {
    console.warn('Waveform decode failed:', err);
    state.peaks = null;
    waveformStatus.hidden = false;
    waveformStatus.textContent = 'Waveform preview unavailable for this file (export still works)';
  }
  drawTimeline();
}

function computePeaks(audioBuffer, resolution) {
  const channels = audioBuffer.numberOfChannels;
  const length = audioBuffer.length;
  const samplesPerBucket = Math.max(1, Math.floor(length / resolution));
  const peaks = new Float32Array(resolution * 2); // [min, max] per bucket

  const chData = [];
  for (let c = 0; c < channels; c++) chData.push(audioBuffer.getChannelData(c));

  for (let b = 0; b < resolution; b++) {
    const start = b * samplesPerBucket;
    const end = Math.min(length, start + samplesPerBucket);
    let min = 1, max = -1;
    for (let i = start; i < end; i++) {
      let v = 0;
      for (let c = 0; c < channels; c++) v += chData[c][i];
      v /= channels;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (end <= start) { min = 0; max = 0; }
    peaks[b * 2] = min;
    peaks[b * 2 + 1] = max;
  }
  return peaks;
}

// ---------- Timeline drawing ----------

function resizeCanvas() {
  const rect = canvas.parentElement.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, rect.width * dpr);
  canvas.height = 96 * dpr;
  canvas.style.width = rect.width + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

window.addEventListener('resize', () => {
  if (!editor.hidden) { resizeCanvas(); drawTimeline(); }
});

const SPROCKET_H = 10;

function drawTimeline() {
  const w = canvas.clientWidth;
  const h = 96;
  ctx.clearRect(0, 0, w, h);

  const styles = getComputedStyle(document.documentElement);
  const graphite2 = styles.getPropertyValue('--graphite-2').trim();
  const teal = styles.getPropertyValue('--teal').trim();
  const tealDim = styles.getPropertyValue('--teal-dim').trim();
  const brass = styles.getPropertyValue('--brass').trim();
  const paper = styles.getPropertyValue('--paper').trim();
  const line = styles.getPropertyValue('--line').trim();

  ctx.fillStyle = graphite2;
  ctx.fillRect(0, 0, w, h);

  // Sprocket ticks (film strip motif) along the top edge
  ctx.fillStyle = line;
  const tickGap = 14;
  for (let x = 4; x < w; x += tickGap) {
    ctx.fillRect(x, 4, 6, SPROCKET_H - 4);
  }

  const waveTop = SPROCKET_H + 8;
  const waveH = h - waveTop - 8;
  const mid = waveTop + waveH / 2;

  if (state.duration > 0) {
    const inX = (state.inPoint / state.duration) * w;
    const outX = (state.outPoint / state.duration) * w;
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(0, waveTop, inX, waveH);
    ctx.fillRect(outX, waveTop, w - outX, waveH);
  }

  if (state.peaks && state.duration > 0) {
    const resolution = state.peaksResolution;
    ctx.fillStyle = teal;
    for (let x = 0; x < w; x++) {
      const bucket = Math.min(resolution - 1, Math.floor((x / w) * resolution));
      const min = state.peaks[bucket * 2];
      const max = state.peaks[bucket * 2 + 1];
      const y1 = mid - max * (waveH / 2);
      const y2 = mid - min * (waveH / 2);
      ctx.fillRect(x, y1, 1, Math.max(1, y2 - y1));
    }
  } else {
    ctx.strokeStyle = tealDim;
    ctx.beginPath();
    ctx.moveTo(0, mid);
    ctx.lineTo(w, mid);
    ctx.stroke();
  }

  if (state.duration > 0) {
    const inX = (state.inPoint / state.duration) * w;
    const outX = (state.outPoint / state.duration) * w;
    ctx.fillStyle = brass;
    ctx.fillRect(inX - 1, waveTop, 3, waveH);
    ctx.fillRect(outX - 2, waveTop, 3, waveH);
    ctx.beginPath();
    ctx.moveTo(inX - 1, waveTop);
    ctx.lineTo(inX - 1 + 8, waveTop);
    ctx.lineTo(inX - 1, waveTop + 8);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(outX + 1, waveTop);
    ctx.lineTo(outX + 1 - 8, waveTop);
    ctx.lineTo(outX + 1, waveTop + 8);
    ctx.fill();

    const playX = (video.currentTime / state.duration) * w;
    ctx.fillStyle = paper;
    ctx.fillRect(playX - 0.5, 0, 1, h);
    ctx.beginPath();
    ctx.moveTo(playX - 4, 0);
    ctx.lineTo(playX + 4, 0);
    ctx.lineTo(playX, 6);
    ctx.fill();
  }
}

// ---------- Timeline interaction ----------

const HANDLE_HIT_PX = 10;

function xToTime(x) {
  const w = canvas.clientWidth;
  return Math.min(state.duration, Math.max(0, (x / w) * state.duration));
}

function timeToX(t) {
  const w = canvas.clientWidth;
  return (t / state.duration) * w;
}

canvas.addEventListener('pointerdown', (e) => {
  if (!state.duration) return;
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const inX = timeToX(state.inPoint);
  const outX = timeToX(state.outPoint);

  if (Math.abs(x - inX) <= HANDLE_HIT_PX) {
    state.dragging = 'in';
  } else if (Math.abs(x - outX) <= HANDLE_HIT_PX) {
    state.dragging = 'out';
  } else {
    state.dragging = 'scrub';
    video.currentTime = xToTime(x);
  }
  canvas.setPointerCapture(e.pointerId);
});

canvas.addEventListener('pointermove', (e) => {
  if (!state.dragging || !state.duration) return;
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const t = xToTime(x);

  if (state.dragging === 'in') {
    state.inPoint = Math.min(t, state.outPoint - 0.05);
    if (state.inPoint < 0) state.inPoint = 0;
  } else if (state.dragging === 'out') {
    state.outPoint = Math.max(t, state.inPoint + 0.05);
    if (state.outPoint > state.duration) state.outPoint = state.duration;
  } else if (state.dragging === 'scrub') {
    video.currentTime = t;
  }
  syncFieldsFromState();
  drawTimeline();
});

window.addEventListener('pointerup', () => { state.dragging = null; });

// ---------- Numeric fields ----------

function syncFieldsFromState() {
  inField.value = formatTimecode(state.inPoint);
  outField.value = formatTimecode(state.outPoint);
  selLength.textContent = formatTimecode(Math.max(0, state.outPoint - state.inPoint));
}

inField.addEventListener('change', () => {
  const t = parseTimecode(inField.value);
  if (!Number.isNaN(t)) state.inPoint = Math.min(Math.max(0, t), state.outPoint - 0.05);
  syncFieldsFromState();
  drawTimeline();
});
outField.addEventListener('change', () => {
  const t = parseTimecode(outField.value);
  if (!Number.isNaN(t)) state.outPoint = Math.max(Math.min(state.duration, t), state.inPoint + 0.05);
  syncFieldsFromState();
  drawTimeline();
});
setInBtn.addEventListener('click', () => {
  state.inPoint = Math.min(video.currentTime, state.outPoint - 0.05);
  syncFieldsFromState();
  drawTimeline();
});
setOutBtn.addEventListener('click', () => {
  state.outPoint = Math.max(video.currentTime, state.inPoint + 0.05);
  syncFieldsFromState();
  drawTimeline();
});

// ---------- Transport ----------

playBtn.addEventListener('click', () => {
  if (video.paused) video.play(); else video.pause();
});
video.addEventListener('play', () => { playIcon.hidden = true; pauseIcon.hidden = false; requestAnimationFrame(tick); });
video.addEventListener('pause', () => { playIcon.hidden = false; pauseIcon.hidden = true; });

toInBtn.addEventListener('click', () => { video.currentTime = state.inPoint; });
toOutBtn.addEventListener('click', () => { video.currentTime = state.outPoint; });
loopToggle.addEventListener('change', () => { state.looping = loopToggle.checked; });

function tick() {
  if (video.paused) return;
  if (state.looping && video.currentTime >= state.outPoint) {
    video.currentTime = state.inPoint;
  }
  timeReadout.textContent = `${formatTimecode(video.currentTime)} / ${formatTimecode(state.duration)}`;
  drawTimeline();
  requestAnimationFrame(tick);
}
video.addEventListener('timeupdate', () => {
  timeReadout.textContent = `${formatTimecode(video.currentTime)} / ${formatTimecode(state.duration)}`;
  if (video.paused) drawTimeline();
});

// ---------- Tabs ----------

tabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    tabs.forEach((t) => { t.classList.remove('active'); t.setAttribute('aria-selected', 'false'); });
    tab.classList.add('active');
    tab.setAttribute('aria-selected', 'true');
    const which = tab.dataset.tab;
    panelTrim.hidden = which !== 'trim';
    panelCaptions.hidden = which !== 'captions';
  });
});

// ===========================================================
// Export — loads FFmpeg (WebAssembly build of real FFmpeg)
// from a CDN only when you click Export. Single-threaded core,
// so it needs no special server headers — works on GitHub Pages.
// ===========================================================

async function exportTrimmedMedia({ file, isAudioOnly, inPoint, outPoint, quality, srtText, onProgress }) {
  onProgress(0, 'Loading FFmpeg…');
  const { FFmpeg } = await import('https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/dist/esm/index.js');
  const { fetchFile, toBlobURL } = await import('https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.1/dist/esm/index.js');

  const ffmpeg = new FFmpeg();
  ffmpeg.on('progress', ({ progress }) => {
    if (typeof progress === 'number' && !Number.isNaN(progress)) {
      onProgress(Math.min(1, Math.max(0, progress)), 'Encoding…');
    }
  });

  const baseURL = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm';
  await ffmpeg.load({
    coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
    wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
  });

  onProgress(0.05, 'Reading file…');
  const ext = (file.name.split('.').pop() || (isAudioOnly ? 'mp3' : 'mp4')).toLowerCase();
  const inputName = `input.${ext}`;
  await ffmpeg.writeFile(inputName, await fetchFile(file));

  const args = ['-i', inputName];
  const hasCaptions = !!srtText && !isAudioOnly;
  if (hasCaptions) {
    await ffmpeg.writeFile('captions.srt', new TextEncoder().encode(srtText));
    args.push('-i', 'captions.srt');
  }
  args.push('-ss', String(inPoint), '-to', String(outPoint));

  const presetMap = { ultrafast: 'ultrafast', fast: 'veryfast', medium: 'medium' };
  const preset = presetMap[quality] || 'veryfast';

  let outputName;
  if (isAudioOnly) {
    args.push('-vn', '-c:a', 'libmp3lame', '-q:a', '2');
    outputName = 'output.mp3';
  } else {
    args.push('-c:v', 'libx264', '-preset', preset, '-crf', '23', '-c:a', 'aac');
    if (hasCaptions) args.push('-c:s', 'mov_text');
    outputName = 'output.mp4';
  }
  args.push(outputName);

  onProgress(0.1, 'Encoding…');
  await ffmpeg.exec(args);

  const data = await ffmpeg.readFile(outputName);
  const mime = isAudioOnly ? 'audio/mpeg' : 'video/mp4';
  const blob = new Blob([data.buffer], { type: mime });
  return URL.createObjectURL(blob);
}

exportBtn.addEventListener('click', async () => {
  exportBtn.disabled = true;
  exportStatus.hidden = false;
  exportDownload.hidden = true;
  exportProgressBar.style.width = '0%';
  exportStatusText.textContent = 'Loading FFmpeg (first time only)…';

  try {
    const blobUrl = await exportTrimmedMedia({
      file: state.file,
      isAudioOnly: state.isAudioOnly,
      inPoint: state.inPoint,
      outPoint: state.outPoint,
      quality: qualitySelect.value,
      srtText: (embedCaptionsToggle.checked && state.transcript) ? state.transcript.srt : null,
      onProgress: (ratio, label) => {
        exportProgressBar.style.width = `${Math.round(ratio * 100)}%`;
        if (label) exportStatusText.textContent = label;
      },
    });

    const ext = state.isAudioOnly ? 'mp3' : 'mp4';
    const baseName = (state.file.name || 'clip').replace(/\.[^.]+$/, '');
    exportDownload.href = blobUrl;
    exportDownload.download = `${baseName}-trimmed.${ext}`;
    exportDownload.hidden = false;
    exportStatusText.textContent = 'Done.';
    exportProgressBar.style.width = '100%';
  } catch (err) {
    console.error(err);
    exportStatusText.textContent = `Export failed: ${err.message || err}`;
  } finally {
    exportBtn.disabled = false;
  }
});

// ===========================================================
// Captions — loads Transformers.js + a Whisper model from a
// CDN only when you click Generate captions. Runs on-device;
// the audio never leaves the browser.
// ===========================================================

async function generateCaptions({ file, modelId, onProgress }) {
  onProgress(0, 'Loading Whisper…');
  const { pipeline } = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.0.0');

  onProgress(0.05, 'Decoding audio…');
  const arrayBuffer = await file.arrayBuffer();
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const actx = new AudioCtx();
  const decoded = await actx.decodeAudioData(arrayBuffer);

  // Mix down to mono at the original sample rate
  const monoData = new Float32Array(decoded.length);
  for (let c = 0; c < decoded.numberOfChannels; c++) {
    const chData = decoded.getChannelData(c);
    for (let i = 0; i < decoded.length; i++) monoData[i] += chData[i] / decoded.numberOfChannels;
  }
  const monoBuffer = actx.createBuffer(1, decoded.length, decoded.sampleRate);
  monoBuffer.copyToChannel(monoData, 0);

  // Resample to 16kHz mono, which Whisper expects
  const targetRate = 16000;
  const offlineCtx = new OfflineAudioContext(1, Math.ceil(decoded.duration * targetRate), targetRate);
  const src = offlineCtx.createBufferSource();
  src.buffer = monoBuffer;
  src.connect(offlineCtx.destination);
  src.start(0);
  const rendered = await offlineCtx.startRendering();
  const audioData = rendered.getChannelData(0);
  actx.close();

  onProgress(0.15, 'Loading model…');
  const transcriber = await pipeline('automatic-speech-recognition', modelId, {
    progress_callback: (p) => {
      if (p && p.status === 'progress' && p.total) {
        onProgress(0.15 + 0.35 * (p.loaded / p.total), `Downloading model… ${Math.round((p.loaded / p.total) * 100)}%`);
      }
    },
  });

  onProgress(0.5, 'Transcribing…');
  const output = await transcriber(audioData, {
    return_timestamps: true,
    chunk_length_s: 30,
    stride_length_s: 5,
  });

  const chunks = output.chunks || [{ text: output.text, timestamp: [0, decoded.duration] }];
  const srt = chunksToSrt(chunks);
  const vtt = chunksToVtt(chunks);
  onProgress(1, 'Done.');
  return { chunks, srt, vtt };
}

function chunksToSrt(chunks) {
  return chunks.map((c, i) => {
    const [start, end] = c.timestamp || [0, 0];
    return `${i + 1}\n${srtTime(start)} --> ${srtTime(end ?? start + 2)}\n${c.text.trim()}\n`;
  }).join('\n');
}
function chunksToVtt(chunks) {
  return 'WEBVTT\n\n' + chunks.map((c) => {
    const [start, end] = c.timestamp || [0, 0];
    return `${vttTime(start)} --> ${vttTime(end ?? start + 2)}\n${c.text.trim()}\n`;
  }).join('\n');
}
function srtTime(t) { return formatTimecode(t || 0).replace('.', ','); }
function vttTime(t) { return formatTimecode(t || 0); }

transcribeBtn.addEventListener('click', async () => {
  transcribeBtn.disabled = true;
  transcribeStatus.hidden = false;
  transcribeProgressBar.style.width = '0%';
  transcribeStatusText.textContent = 'Loading Whisper (first time only)…';

  try {
    const result = await generateCaptions({
      file: state.file,
      modelId: modelSelect.value,
      onProgress: (ratio, label) => {
        transcribeProgressBar.style.width = `${Math.round(Math.min(1, Math.max(0, ratio)) * 100)}%`;
        if (label) transcribeStatusText.textContent = label;
      },
    });
    state.transcript = result;
    renderTranscript(result.chunks);
    embedCaptionsRow.hidden = false;
    transcribeStatusText.textContent = `Done — ${result.chunks.length} lines.`;
  } catch (err) {
    console.error(err);
    transcribeStatusText.textContent = `Captioning failed: ${err.message || err}`;
  } finally {
    transcribeBtn.disabled = false;
  }
});

function renderTranscript(chunks) {
  transcriptList.innerHTML = '';
  chunks.forEach((c) => {
    const li = document.createElement('li');
    const start = Array.isArray(c.timestamp) ? c.timestamp[0] : 0;
    li.innerHTML = `<span class="t-time">${formatTimecode(start || 0).slice(0, 8)}</span><span>${escapeHtml(c.text.trim())}</span>`;
    li.addEventListener('click', () => { video.currentTime = start || 0; video.pause(); });
    transcriptList.appendChild(li);
  });
  transcriptPanel.hidden = false;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

downloadSrtBtn.addEventListener('click', () => downloadText(state.transcript && state.transcript.srt, 'captions.srt'));
downloadVttBtn.addEventListener('click', () => downloadText(state.transcript && state.transcript.vtt, 'captions.vtt'));

function downloadText(text, filename) {
  if (!text) return;
  const blob = new Blob([text], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
