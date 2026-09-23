import { FFmpeg } from 'https://unpkg.com/@ffmpeg/ffmpeg@0.12.10/dist/esm/index.js';
import { toBlobURL, fetchFile } from 'https://unpkg.com/@ffmpeg/util@0.12.1/dist/esm/index.js';

// State Aplikasi
let subtitles = [];
let activeCue = null;
let currentMkvFile = null;
let ffmpeg = null;

// Elemen DOM
const mkvInput = document.getElementById('mkvInput');
const fileName = document.getElementById('fileName');
const statusMsg = document.getElementById('status');
const workspace = document.getElementById('workspace');
const video = document.getElementById('videoPlayer');
const overlay = document.getElementById('subtitleOverlay');
const subTableBody = document.getElementById('subTableBody');
const addCueBtn = document.getElementById('addCueBtn');
const exportSrtBtn = document.getElementById('exportSrtBtn');
const exportMkvBtn = document.getElementById('exportMkvBtn');

// 1. Inisialisasi FFmpeg.wasm
async function initFFmpeg() {
  if (ffmpeg) return ffmpeg;
  statusMsg.innerText = "Memuat engine WebAssembly FFmpeg...";
  ffmpeg = new FFmpeg();
  
  const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm';
  await ffmpeg.load({
    coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
    wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm')
  });

  statusMsg.innerText = "FFmpeg Siap Digunakan.";
  return ffmpeg;
}

// 2. Event Input File
mkvInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  currentMkvFile = file;
  fileName.innerText = `${file.name} (${(file.size / (1024 * 1024)).toFixed(1)} MB)`;
  workspace.style.display = 'block';

  // Bind video ke player HTML5
  video.src = URL.createObjectURL(file);
  subtitles = [];
  renderTable();

  // Coba ekstraksi subtitle internal MKV via ffmpeg
  try {
    statusMsg.innerText = "Mengekstrak subtitle dari MKV...";
    const ff = await initFFmpeg();
    await ff.writeFile('input.mkv', await fetchFile(file));

    // Ekstrak stream subtitle pertama ke format SRT
    await ff.exec(['-i', 'input.mkv', '-map', '0:s:0', 'extracted.srt']);
    const srtData = await ff.readFile('extracted.srt');
    const srtText = new TextDecoder().decode(srtData);

    subtitles = parseSRT(srtText);
    renderTable();
    statusMsg.innerText = `Berhasil mengekstrak ${subtitles.length} baris subtitle!`;
  } catch (err) {
    statusMsg.innerText = "MKV tidak memiliki subtitle internal (atau tidak terbaca). Anda bisa menambah manual.";
    // Buat 1 cue default awal
    subtitles = [{ id: 1, start: 1.0, end: 4.0, text: "Ketik subtitle pertama di sini..." }];
    renderTable();
  }
});

// 3. Sinkronisasi Video Player dengan Subtitle Overlay
video.addEventListener('timeupdate', () => {
  // Jika user sedang aktif mengetik di overlay, jangan ditimpa
  if (overlay.getAttribute('contenteditable') === 'true') return;

  const curTime = video.currentTime;
  activeCue = subtitles.find(s => curTime >= s.start && curTime <= s.end);

  if (activeCue) {
    overlay.innerText = activeCue.text;
    overlay.style.display = 'block';
  } else {
    overlay.style.display = 'none';
  }
});

// 4. Mekanisme "Klik Subtitle di Layar Langsung Edit"
overlay.addEventListener('click', () => {
  if (!activeCue) return;
  video.pause(); // Otomatis pause agar video tidak jalan saat mengedit
  overlay.setAttribute('contenteditable', 'true');
  overlay.focus();
});

// Simpan saat selesai diedit (blur / lepas fokus)
overlay.addEventListener('blur', () => {
  overlay.setAttribute('contenteditable', 'false');
  if (activeCue) {
    activeCue.text = overlay.innerText;
    renderTable();
  }
});

overlay.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    overlay.blur(); // Pemicu event 'blur'
  }
});

// 5. Tambah Cue Manual
addCueBtn.addEventListener('click', () => {
  const cur = video.currentTime;
  const newCue = {
    id: Date.now(),
    start: Number(cur.toFixed(2)),
    end: Number((cur + 2.5).toFixed(2)),
    text: "Teks baru"
  };
  subtitles.push(newCue);
  subtitles.sort((a, b) => a.start - b.start);
  renderTable();
});

// 6. Render Subtitle Table
function renderTable() {
  subTableBody.innerHTML = '';
  subtitles.forEach((sub, idx) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><input type="number" step="0.1" class="table-input" value="${sub.start}" data-idx="${idx}" data-field="start" /></td>
      <td><input type="number" step="0.1" class="table-input" value="${sub.end}" data-idx="${idx}" data-field="end" /></td>
      <td><input type="text" class="table-input" value="${sub.text}" data-idx="${idx}" data-field="text" /></td>
      <td><button class="btn btn-danger" data-idx="${idx}">Hapus</button></td>
    `;
    subTableBody.appendChild(tr);
  });

  // Table event listeners
  subTableBody.querySelectorAll('input').forEach(input => {
    input.addEventListener('change', (e) => {
      const idx = e.target.dataset.idx;
      const field = e.target.dataset.field;
      subtitles[idx][field] = field === 'text' ? e.target.value : parseFloat(e.target.value);
      subtitles.sort((a, b) => a.start - b.start);
    });
  });

  subTableBody.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const idx = e.target.dataset.idx;
      subtitles.splice(idx, 1);
      renderTable();
    });
  });
}

// 7. Opsi Ekspor 1: Unduh File .SRT Langsung
exportSrtBtn.addEventListener('click', () => {
  if (subtitles.length === 0) return alert("Belum ada subtitle!");
  const srtContent = stringifySRT(subtitles);
  const blob = new Blob([srtContent], { type: 'text/plain;charset=utf-8' });
  downloadBlob(blob, 'edited_subtitles.srt');
});

// 8. Opsi Ekspor 2: In-browser Muxing ke MKV
exportMkvBtn.addEventListener('click', async () => {
  if (!currentMkvFile) return;
  try {
    exportMkvBtn.disabled = true;
    statusMsg.innerText = "Sedang melakukan remuxing MKV (proses cepat)...";

    const ff = await initFFmpeg();
    const srtString = stringifySRT(subtitles);

    await ff.writeFile('input.mkv', await fetchFile(currentMkvFile));
    await ff.writeFile('new_subs.srt', srtString);

    // Muxing tanpa re-encode video/audio (-c copy)
    await ff.exec([
      '-i', 'input.mkv',
      '-i', 'new_subs.srt',
      '-map', '0:v',
      '-map', '0:a?',
      '-map', '1:s',
      '-c', 'copy',
      '-metadata:s:s:0', 'language=ind',
      'output.mkv'
    ]);

    const data = await ff.readFile('output.mkv');
    const blob = new Blob([data.buffer], { type: 'video/x-matroska' });
    downloadBlob(blob, `edited_${currentMkvFile.name}`);

    statusMsg.innerText = "Muxing selesai! File siap diunduh.";
  } catch (err) {
    console.error(err);
    alert("Gagal melakukan muxing. File mungkin terlalu besar untuk RAM browser.");
    statusMsg.innerText = "Terjadi kesalahan saat muxing.";
  } finally {
    exportMkvBtn.disabled = false;
  }
});

// Helper: Download Blob
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// Helper: Parser & Stringifier SRT
function stringifySRT(cues) {
  return cues.map((cue, i) => {
    return `${i + 1}\n${secToSrt(cue.start)} --> ${secToSrt(cue.end)}\n${cue.text}\n\n`;
  }).join('');
}

function secToSrt(sec) {
  const pad = (n, z = 2) => ('00' + n).slice(-z);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.floor((sec % 1) * 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}

function parseSRT(data) {
  const regex = /(\d+)\r?\n(\d{2}:\d{2}:\d{2},\d{3}) --> (\d{2}:\d{2}:\d{2},\d{3})\r?\n([\s\S]*?)(?=\r?\n\r?\n|\r?\n*$)/g;
  let matches, result = [];
  while ((matches = regex.exec(data)) !== null) {
    result.push({
      id: Number(matches[1]),
      start: srtToSec(matches[2]),
      end: srtToSec(matches[3]),
      text: matches[4].trim()
    });
  }
  return result;
}

function srtToSec(timeStr) {
  const [h, m, sWithMs] = timeStr.split(':');
  const [s, ms] = sWithMs.split(',');
  return (+h) * 3600 + (+m) * 60 + (+s) + (+ms) / 1000;
}
