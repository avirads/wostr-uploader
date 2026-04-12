const STORAGE_KEY = 'atlas-uploader-sessions-v1';
const RETRY_LIMIT = 4;
const DEFAULT_CHUNK_SIZE = 32 * 1024 * 1024;
const DEFAULT_MAX_PARALLEL = 4;

const dom = {
  fileInput: document.getElementById('fileInput'),
  dropzone: document.getElementById('dropzone'),
  fileMeta: document.getElementById('fileMeta'),
  statusLine: document.getElementById('statusLine'),
  cancelButton: document.getElementById('cancelButton'),
  progressLabel: document.getElementById('progressLabel'),
  speedLabel: document.getElementById('speedLabel'),
  etaLabel: document.getElementById('etaLabel'),
  stateLabel: document.getElementById('stateLabel'),
  uploadedBytes: document.getElementById('uploadedBytes'),
  totalBytes: document.getElementById('totalBytes'),
  progressBar: document.getElementById('progressBar'),
  downloadLink: document.getElementById('downloadLink'),
  canvas: document.getElementById('scene')
};

const state = {
  file: null,
  session: null,
  resumeSummary: null,
  partStates: [],
  partRetryAt: [],
  attempts: [],
  controllers: new Map(),
  activeRequests: 0,
  uploading: false,
  paused: false,
  finalizing: false,
  cancelling: false,
  bytesUploaded: 0,
  speedBytesPerSecond: 0,
  samples: [],
  retryTimer: null,
  message: 'Select a file to begin upload.',
  downloadUrl: null
};

function deriveStageLabel() {
  if (state.cancelling) {
    return 'Cancelling';
  }

  if (state.downloadUrl) {
    return 'Complete';
  }

  if (state.finalizing) {
    return 'Finalizing';
  }

  if (state.uploading) {
    return 'Uploading';
  }

  if (state.paused) {
    return 'Paused';
  }

  if (state.file) {
    return 'Ready';
  }

  return 'Idle';
}
let visualizer = {
  displayCount: 144,
  setSnapshot() {}
};

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }

  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let index = 0;

  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }

  const decimals = value >= 10 || index === 0 ? 0 : 1;
  return `${value.toFixed(decimals)} ${units[index]}`;
}

function formatRate(bytesPerSecond) {
  return `${formatBytes(bytesPerSecond)}/s`;
}

function formatEta(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return '--';
  }

  const rounded = Math.round(seconds);
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const remainingSeconds = rounded % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }

  if (minutes > 0) {
    return `${minutes}m ${remainingSeconds}s`;
  }

  return `${remainingSeconds}s`;
}

function fingerprintFile(file) {
  return `${file.name}::${file.size}::${file.lastModified}`;
}

function loadSessionCache() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
  } catch {
    return {};
  }
}

function saveSessionCache(cache) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
}

function saveSessionForFile(file, summary) {
  const cache = loadSessionCache();
  cache[fingerprintFile(file)] = {
    uploadId: summary.uploadId,
    fileName: file.name,
    fileSize: file.size,
    lastModified: file.lastModified,
    chunkSize: summary.chunkSize,
    maxParallel: summary.maxParallel
  };
  saveSessionCache(cache);
}

function clearSessionForFile(file) {
  if (!file) {
    return;
  }

  const cache = loadSessionCache();
  delete cache[fingerprintFile(file)];
  saveSessionCache(cache);
}

function getSavedSession(file) {
  return loadSessionCache()[fingerprintFile(file)] ?? null;
}

function clearRetryTimer() {
  if (state.retryTimer !== null) {
    window.clearTimeout(state.retryTimer);
    state.retryTimer = null;
  }
}

function updateThroughput(totalBytes) {
  const now = performance.now();
  state.samples.push({ time: now, bytes: totalBytes });
  state.samples = state.samples.filter((sample) => now - sample.time <= 15000);

  if (state.samples.length >= 2) {
    const first = state.samples[0];
    const last = state.samples[state.samples.length - 1];
    const seconds = (last.time - first.time) / 1000;
    state.speedBytesPerSecond = seconds > 0 ? (last.bytes - first.bytes) / seconds : 0;
  } else {
    state.speedBytesPerSecond = 0;
  }
}

function resetRuntime({ keepFile = false } = {}) {
  clearRetryTimer();

  for (const controller of state.controllers.values()) {
    controller.abort();
  }

  state.controllers.clear();
  state.activeRequests = 0;
  state.uploading = false;
  state.paused = false;
  state.finalizing = false;
  state.cancelling = false;
  state.session = null;
  state.resumeSummary = null;
  state.partStates = [];
  state.partRetryAt = [];
  state.attempts = [];
  state.bytesUploaded = 0;
  state.speedBytesPerSecond = 0;
  state.samples = [];
  state.downloadUrl = null;
  state.message = keepFile
    ? 'Preparing upload.'
    : 'Select a file to begin upload.';

  if (!keepFile) {
    state.file = null;
  }
}

async function readApiError(response) {
  try {
    const payload = await response.json();
    return payload.error ?? `Request failed with ${response.status}`;
  } catch {
    return `Request failed with ${response.status}`;
  }
}

async function sha256Hex(arrayBuffer) {
  const digest = await crypto.subtle.digest('SHA-256', arrayBuffer);
  const bytes = new Uint8Array(digest);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function compressPartStates(partStates, displayCount) {
  if (!partStates.length) {
    return Array(displayCount).fill('queued');
  }

  const compressed = [];

  for (let index = 0; index < displayCount; index += 1) {
    const start = Math.floor((index / displayCount) * partStates.length);
    const end = Math.max(start + 1, Math.floor(((index + 1) / displayCount) * partStates.length));
    const slice = partStates.slice(start, end);

    if (slice.includes('error')) {
      compressed.push('error');
    } else if (slice.includes('uploading')) {
      compressed.push('uploading');
    } else if (slice.every((value) => value === 'done')) {
      compressed.push('done');
    } else {
      compressed.push('queued');
    }
  }

  return compressed;
}

function refreshUi() {
  const totalBytes = state.file?.size ?? state.session?.fileSize ?? 0;
  const progress = totalBytes > 0 ? state.bytesUploaded / totalBytes : 0;
  const etaSeconds = state.speedBytesPerSecond > 0
    ? (totalBytes - state.bytesUploaded) / state.speedBytesPerSecond
    : Number.NaN;

  dom.fileMeta.textContent = state.file
    ? `${state.file.name} (${formatBytes(state.file.size)})`
    : 'No file selected';
  dom.progressLabel.textContent = `${Math.min(progress * 100, 100).toFixed(1)}%`;
  dom.speedLabel.textContent = formatRate(state.speedBytesPerSecond);
  dom.etaLabel.textContent = formatEta(etaSeconds);
  dom.stateLabel.textContent = deriveStageLabel();
  dom.uploadedBytes.textContent = formatBytes(state.bytesUploaded);
  dom.totalBytes.textContent = formatBytes(totalBytes);
  dom.progressBar.style.width = `${Math.min(progress * 100, 100)}%`;
  dom.statusLine.textContent = state.message;
  dom.cancelButton.classList.toggle('hidden', !state.session);
  dom.cancelButton.disabled = state.cancelling;
  dom.cancelButton.textContent = state.downloadUrl ? 'Delete uploaded file' : 'Cancel upload';

  if (state.downloadUrl) {
    dom.downloadLink.href = state.downloadUrl;
    dom.downloadLink.classList.remove('hidden');
  } else {
    dom.downloadLink.classList.add('hidden');
  }

  visualizer.setSnapshot({
    compressedStates: compressPartStates(state.partStates, visualizer.displayCount),
    progress,
    completed: Boolean(state.downloadUrl)
  });
}

async function initVisualizer() {
  try {
    const module = await import('/visualizer.js');
    visualizer = module.createVisualizer(dom.canvas);
    refreshUi();
  } catch {
    dom.canvas.style.display = 'none';
  }
}

async function fetchUploadSummary(uploadId) {
  const response = await fetch(`/api/uploads/${uploadId}`);

  if (!response.ok) {
    throw new Error(await readApiError(response));
  }

  return response.json();
}

function hydrateFromSummary(summary) {
  state.session = summary;
  state.partStates = Array(summary.partCount).fill('queued');
  state.partRetryAt = Array(summary.partCount).fill(0);
  state.attempts = Array(summary.partCount).fill(0);

  for (const partNumber of summary.uploadedParts) {
    state.partStates[partNumber] = 'done';
  }

  state.bytesUploaded = summary.uploadedBytes;
  updateThroughput(summary.uploadedBytes);

  if (summary.status === 'complete' && summary.downloadUrl) {
    state.downloadUrl = summary.downloadUrl;
  }
}

async function inspectSavedSession(file) {
  const saved = getSavedSession(file);

  if (!saved) {
    state.message = 'Creating a new upload session.';
    refreshUi();
    return;
  }

  try {
    const summary = await fetchUploadSummary(saved.uploadId);

    if (summary.fileName !== file.name || summary.fileSize !== file.size) {
      clearSessionForFile(file);
      state.message = 'Creating a new upload session.';
      refreshUi();
      return;
    }

    if (summary.status === 'complete') {
      clearSessionForFile(file);
      state.message = 'Previous upload already completed. Creating a fresh session.';
      refreshUi();
      return;
    }

    state.resumeSummary = summary;
    hydrateFromSummary(summary);
    state.message = 'Resuming the existing upload session.';
  } catch {
    clearSessionForFile(file);
    state.message = 'Creating a new upload session.';
  }

  refreshUi();
}

async function createSession(file) {
  const response = await fetch('/api/uploads', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      fileName: file.name,
      fileSize: file.size,
      mimeType: file.type || 'application/octet-stream',
      chunkSize: DEFAULT_CHUNK_SIZE,
      maxParallel: DEFAULT_MAX_PARALLEL
    })
  });

  if (!response.ok) {
    throw new Error(await readApiError(response));
  }

  return response.json();
}

function getNextQueuedPart() {
  const now = Date.now();

  for (let index = 0; index < state.partStates.length; index += 1) {
    if (state.partStates[index] === 'error') {
      continue;
    }

    if (state.partStates[index] === 'queued' && state.partRetryAt[index] <= now) {
      return index;
    }
  }

  return null;
}

function allPartsDone() {
  return state.partStates.length > 0 && state.partStates.every((value) => value === 'done');
}

async function finalizeUpload() {
  if (!state.session || state.finalizing || state.downloadUrl) {
    return;
  }

  state.finalizing = true;
  state.message = 'Verifying all parts and finalizing the upload.';
  refreshUi();

  try {
    const response = await fetch(`/api/uploads/${state.session.uploadId}/complete`, {
      method: 'POST'
    });

    if (!response.ok) {
      throw new Error(await readApiError(response));
    }

    const summary = await response.json();
    state.session = summary;
    state.bytesUploaded = summary.fileSize;
    state.downloadUrl = summary.downloadUrl;
    state.uploading = false;
    state.paused = false;
    state.message = 'Upload complete. The file has been finalized on the server.';
    clearSessionForFile(state.file);
  } catch (error) {
    state.uploading = false;
    state.paused = true;
    state.message = error instanceof Error
      ? `${error.message} Select the same file again to retry.`
      : 'Failed to finalize upload. Select the same file again to retry.';
  } finally {
    state.finalizing = false;
    refreshUi();
  }
}

async function uploadPart(partNumber) {
  if (!state.file || !state.session) {
    return;
  }

  const start = partNumber * state.session.chunkSize;
  const end = Math.min(start + state.session.chunkSize, state.file.size);
  const blob = state.file.slice(start, end);
  const controller = new AbortController();

  state.controllers.set(partNumber, controller);
  state.activeRequests += 1;
  state.partStates[partNumber] = 'uploading';
  refreshUi();

  try {
    const buffer = await blob.arrayBuffer();

    if (controller.signal.aborted) {
      throw new DOMException('Upload aborted', 'AbortError');
    }

    const checksum = await sha256Hex(buffer);
    const response = await fetch(`/api/uploads/${state.session.uploadId}/parts/${partNumber}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Part-Checksum': checksum,
        'X-Part-Size': String(buffer.byteLength),
        'X-Upload-Offset': String(start)
      },
      body: buffer,
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(await readApiError(response));
    }

    const summary = await response.json();
    state.partStates[partNumber] = 'done';
    state.bytesUploaded = summary.uploadedBytes;
    updateThroughput(summary.uploadedBytes);
    state.message = `Uploaded part ${partNumber + 1} of ${state.session.partCount}.`;
  } catch (error) {
    if (controller.signal.aborted) {
      if (state.partStates[partNumber] !== 'done') {
        state.partStates[partNumber] = 'queued';
      }
      return;
    }

    const attempts = (state.attempts[partNumber] ?? 0) + 1;
    state.attempts[partNumber] = attempts;

    if (attempts < RETRY_LIMIT) {
      const backoffMs = Math.min(6000, 700 * 2 ** attempts);
      state.partStates[partNumber] = 'queued';
      state.partRetryAt[partNumber] = Date.now() + backoffMs;
      state.message = `Part ${partNumber + 1} failed. Retrying in ${(backoffMs / 1000).toFixed(1)}s.`;
    } else {
      state.partStates[partNumber] = 'error';
      state.message = `Part ${partNumber + 1} failed repeatedly. Select the same file again to resume.`;
    }
  } finally {
    state.controllers.delete(partNumber);
    state.activeRequests = Math.max(0, state.activeRequests - 1);
    refreshUi();
    pumpQueue();
  }
}

function pumpQueue() {
  clearRetryTimer();

  if (!state.session || !state.uploading || state.paused || state.finalizing) {
    return;
  }

  while (state.activeRequests < state.session.maxParallel) {
    const nextPart = getNextQueuedPart();

    if (nextPart === null) {
      break;
    }

    void uploadPart(nextPart);
  }

  if (state.activeRequests === 0) {
    if (allPartsDone()) {
      void finalizeUpload();
      return;
    }

    if (state.partStates.includes('error')) {
      state.uploading = false;
      state.paused = true;
      state.message = 'Upload paused after repeated failures. Select the same file again to resume.';
      refreshUi();
      return;
    }

    const futureRetries = state.partRetryAt.filter((value) => value > Date.now());

    if (futureRetries.length > 0) {
      const delay = Math.max(50, Math.min(...futureRetries) - Date.now());
      state.retryTimer = window.setTimeout(() => {
        state.retryTimer = null;
        pumpQueue();
      }, delay);
    }
  }
}

async function startUpload() {
  if (!state.file) {
    state.message = 'Choose a file first.';
    refreshUi();
    return;
  }

  state.downloadUrl = null;
  state.samples = [];
  state.speedBytesPerSecond = 0;

  try {
    let summary = state.resumeSummary;

    if (!summary) {
      summary = await createSession(state.file);
      saveSessionForFile(state.file, summary);
    }

    hydrateFromSummary(summary);
    state.resumeSummary = summary;
    state.session = summary;
    state.uploading = true;
    state.paused = false;
    state.message = 'Uploading file.';
    refreshUi();
    pumpQueue();
  } catch (error) {
    state.message = error instanceof Error ? error.message : 'Failed to start upload.';
    refreshUi();
  }
}

function pauseUpload() {
  if (!state.uploading) {
    return;
  }

  clearRetryTimer();
  state.paused = true;
  state.message = 'Upload paused. The session remains resumable.';

  for (const controller of state.controllers.values()) {
    controller.abort();
  }

  refreshUi();
}

function resumeUpload() {
  if (!state.session) {
    void startUpload();
    return;
  }

  for (let index = 0; index < state.partStates.length; index += 1) {
    if (state.partStates[index] === 'error') {
      state.partStates[index] = 'queued';
      state.attempts[index] = 0;
      state.partRetryAt[index] = 0;
    }
  }

  state.uploading = true;
  state.paused = false;
  state.message = 'Resuming upload.';
  refreshUi();
  pumpQueue();
}

async function cancelUpload() {
  if (state.cancelling) {
    return;
  }

  if (!state.session) {
    resetRuntime();
    refreshUi();
    return;
  }

  const deletingCompletedFile = Boolean(state.downloadUrl);

  state.cancelling = true;
  state.uploading = false;
  state.paused = false;
  state.finalizing = false;
  state.message = deletingCompletedFile
    ? 'Deleting the uploaded file from the server.'
    : 'Cancelling upload and deleting it from the server.';
  refreshUi();

  clearRetryTimer();

  for (const controller of state.controllers.values()) {
    controller.abort();
  }

  try {
    const response = await fetch(`/api/uploads/${state.session.uploadId}`, {
      method: 'DELETE'
    });

    if (!response.ok) {
      throw new Error(await readApiError(response));
    }
  } catch {
    state.cancelling = false;
    state.message = 'Failed to cancel the upload. Try again.';
    refreshUi();
    return;
  }

  clearSessionForFile(state.file);
  resetRuntime();
  state.message = deletingCompletedFile
    ? 'Uploaded file deleted from the server.'
    : 'Upload cancelled and removed from the server.';
  dom.fileInput.value = '';
  refreshUi();
}

async function handleFileSelection(file) {
  if (!file) {
    return;
  }

  if (
    state.session &&
    !state.downloadUrl &&
    state.file &&
    fingerprintFile(state.file) !== fingerprintFile(file)
  ) {
    state.message = 'Cancel the current upload before selecting a different file.';
    refreshUi();
    return;
  }

  resetRuntime();
  state.file = file;
  state.message = 'Preparing upload.';
  refreshUi();
  await inspectSavedSession(file);
  await startUpload();
}

function installDragAndDrop() {
  dom.dropzone.addEventListener('click', () => {
    dom.fileInput.value = '';
    dom.fileInput.click();
  });

  dom.dropzone.addEventListener('dragenter', (event) => {
    event.preventDefault();
    dom.dropzone.classList.add('is-dragging');
  });

  dom.dropzone.addEventListener('dragover', (event) => {
    event.preventDefault();
    dom.dropzone.classList.add('is-dragging');
  });

  dom.dropzone.addEventListener('dragleave', () => {
    dom.dropzone.classList.remove('is-dragging');
  });

  dom.dropzone.addEventListener('drop', (event) => {
    event.preventDefault();
    dom.dropzone.classList.remove('is-dragging');
    const [file] = event.dataTransfer?.files ?? [];

    if (file) {
      void handleFileSelection(file);
    }
  });
}

function installEventHandlers() {
  dom.fileInput.addEventListener('change', () => {
    const [file] = dom.fileInput.files ?? [];

    if (file) {
      void handleFileSelection(file);
    }
  });

  dom.cancelButton.addEventListener('click', () => {
    void cancelUpload();
  });

  installDragAndDrop();
}

installEventHandlers();
refreshUi();
void initVisualizer();
