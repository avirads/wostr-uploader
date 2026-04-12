import { createWriteStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const ROOT = import.meta.dir;
const PUBLIC_ROOT = path.join(ROOT, 'public');
const DATA_ROOT = path.join(ROOT, 'data');
const UPLOAD_ROOT = path.join(DATA_ROOT, 'uploads');
const FINAL_ROOT = path.join(DATA_ROOT, 'final');

const MAX_FILE_SIZE = 100 * 1024 * 1024 * 1024;
const DEFAULT_CHUNK_SIZE = 32 * 1024 * 1024;
const MIN_CHUNK_SIZE = 8 * 1024 * 1024;
const MAX_CHUNK_SIZE = 256 * 1024 * 1024;
const DEFAULT_MAX_PARALLEL = 4;
const MAX_PARALLEL = 8;
const MAX_JSON_BYTES = 1_000_000;
const PORT = Number(process.env.PORT || 8080);

const uploadLocks = new Map();
const activePartUploads = new Map();

class HttpError extends Error {
  constructor(statusCode, message, details) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.details = details;
  }
}

class VerifyingTransform extends Transform {
  constructor(expectedBytes) {
    super();
    this.expectedBytes = expectedBytes;
    this.bytesWritten = 0;
    this.hash = crypto.createHash('sha256');
  }

  _transform(chunk, encoding, callback) {
    const nextSize = this.bytesWritten + chunk.length;

    if (nextSize > this.expectedBytes) {
      callback(new HttpError(400, `Part exceeds expected size of ${this.expectedBytes} bytes.`));
      return;
    }

    this.bytesWritten = nextSize;
    this.hash.update(chunk);
    callback(null, chunk);
  }

  digest() {
    return this.hash.digest('hex');
  }
}

function json(payload, init = 200) {
  const status = typeof init === 'number' ? init : init.status ?? 200;
  const headers = new Headers(typeof init === 'number' ? undefined : init.headers);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  return new Response(JSON.stringify(payload, null, 2), { status, headers });
}

function empty(status = 204) {
  return new Response(null, { status });
}

function sanitizeFileName(fileName) {
  const normalized = path.basename(fileName).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').trim();
  return normalized || 'upload.bin';
}

function metadataPath(uploadId) {
  return path.join(UPLOAD_ROOT, `${uploadId}.json`);
}

function tempPath(uploadId) {
  return path.join(UPLOAD_ROOT, `${uploadId}.upload`);
}

function normalizeChunkSize(value) {
  if (value === undefined || value === null || value === '') {
    return DEFAULT_CHUNK_SIZE;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < MIN_CHUNK_SIZE || parsed > MAX_CHUNK_SIZE) {
    throw new HttpError(
      400,
      `chunkSize must be an integer between ${MIN_CHUNK_SIZE} and ${MAX_CHUNK_SIZE}.`
    );
  }

  return parsed;
}

function normalizeParallel(value) {
  if (value === undefined || value === null || value === '') {
    return DEFAULT_MAX_PARALLEL;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_PARALLEL) {
    throw new HttpError(400, `maxParallel must be an integer between 1 and ${MAX_PARALLEL}.`);
  }

  return parsed;
}

function parseNonNegativeInt(value, label) {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new HttpError(400, `${label} must be a non-negative integer.`);
  }

  return parsed;
}

function computeUploadedBytes(uploadedParts) {
  return Object.values(uploadedParts).reduce((sum, part) => sum + (part.size ?? 0), 0);
}

function summarizeMetadata(metadata) {
  return {
    uploadId: metadata.id,
    fileName: metadata.originalName,
    fileSize: metadata.fileSize,
    mimeType: metadata.mimeType,
    chunkSize: metadata.chunkSize,
    partCount: metadata.partCount,
    maxParallel: metadata.maxParallel,
    uploadedBytes: computeUploadedBytes(metadata.uploadedParts),
    uploadedParts: Object.keys(metadata.uploadedParts)
      .map((value) => Number(value))
      .sort((left, right) => left - right),
    status: metadata.status,
    createdAt: metadata.createdAt,
    updatedAt: metadata.updatedAt,
    completedAt: metadata.completedAt ?? null,
    downloadUrl: metadata.downloadUrl ?? null
  };
}

function expectedPartSize(metadata, partNumber) {
  const start = partNumber * metadata.chunkSize;
  return Math.min(metadata.chunkSize, metadata.fileSize - start);
}

function allPartsPresent(metadata) {
  const uploaded = new Set(Object.keys(metadata.uploadedParts).map((value) => Number(value)));

  if (uploaded.size !== metadata.partCount) {
    return false;
  }

  for (let index = 0; index < metadata.partCount; index += 1) {
    if (!uploaded.has(index)) {
      return false;
    }
  }

  return true;
}

function getHeader(request, name) {
  return request.headers.get(name);
}

function getActiveSet(uploadId) {
  let set = activePartUploads.get(uploadId);

  if (!set) {
    set = new Set();
    activePartUploads.set(uploadId, set);
  }

  return set;
}

function releaseActivePart(uploadId, partNumber) {
  const set = activePartUploads.get(uploadId);

  if (!set) {
    return;
  }

  set.delete(partNumber);

  if (set.size === 0) {
    activePartUploads.delete(uploadId);
  }
}

function withUploadLock(uploadId, operation) {
  const previous = uploadLocks.get(uploadId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(operation);
  const cleanup = next.finally(() => {
    if (uploadLocks.get(uploadId) === cleanup) {
      uploadLocks.delete(uploadId);
    }
  });

  uploadLocks.set(uploadId, cleanup);
  return next;
}

async function ensureRoots() {
  await fs.mkdir(PUBLIC_ROOT, { recursive: true });
  await fs.mkdir(UPLOAD_ROOT, { recursive: true });
  await fs.mkdir(FINAL_ROOT, { recursive: true });
}

async function ensureUploadFile(uploadId) {
  const handle = await fs.open(tempPath(uploadId), 'a');
  await handle.close();
}

async function loadMetadata(uploadId) {
  try {
    const raw = await fs.readFile(metadataPath(uploadId), 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      throw new HttpError(404, `Upload ${uploadId} was not found.`);
    }

    throw error;
  }
}

async function storeMetadata(uploadId, metadata) {
  await fs.writeFile(metadataPath(uploadId), JSON.stringify(metadata, null, 2));
}

async function readJsonBody(request) {
  const contentLength = Number(request.headers.get('content-length') ?? '0');

  if (Number.isFinite(contentLength) && contentLength > MAX_JSON_BYTES) {
    throw new HttpError(413, 'JSON body exceeded the 1MB limit.');
  }

  const raw = await request.text();

  if (new TextEncoder().encode(raw).byteLength > MAX_JSON_BYTES) {
    throw new HttpError(413, 'JSON body exceeded the 1MB limit.');
  }

  if (!raw.trim()) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'Request body must contain valid JSON.');
  }
}

async function resolveUniqueFinalName(baseName) {
  const extension = path.extname(baseName);
  const stem = path.basename(baseName, extension);
  let candidate = baseName;
  let counter = 1;

  for (;;) {
    try {
      await fs.access(path.join(FINAL_ROOT, candidate));
      candidate = `${stem}-${counter}${extension}`;
      counter += 1;
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ENOENT') {
        return candidate;
      }

      throw error;
    }
  }
}

async function handleCreateUpload(request) {
  const body = await readJsonBody(request);
  const fileName = typeof body.fileName === 'string' ? body.fileName.trim() : '';
  const mimeType = typeof body.mimeType === 'string' && body.mimeType.trim()
    ? body.mimeType.trim()
    : 'application/octet-stream';
  const fileSize = Number(body.fileSize);
  const chunkSize = normalizeChunkSize(body.chunkSize);
  const maxParallel = normalizeParallel(body.maxParallel);

  if (!fileName) {
    throw new HttpError(400, 'fileName is required.');
  }

  if (!Number.isFinite(fileSize) || fileSize <= 0) {
    throw new HttpError(400, 'fileSize must be a positive number.');
  }

  if (fileSize > MAX_FILE_SIZE) {
    throw new HttpError(400, 'fileSize exceeds the 100GB limit.');
  }

  const uploadId = crypto.randomUUID();
  const now = new Date().toISOString();
  const metadata = {
    id: uploadId,
    originalName: fileName,
    safeFileName: sanitizeFileName(fileName),
    fileSize,
    mimeType,
    chunkSize,
    partCount: Math.ceil(fileSize / chunkSize),
    maxParallel,
    uploadedParts: {},
    status: 'created',
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    downloadUrl: null
  };

  await ensureUploadFile(uploadId);
  await storeMetadata(uploadId, metadata);

  return json(summarizeMetadata(metadata), 201);
}

async function handleGetUpload(uploadId) {
  const metadata = await loadMetadata(uploadId);
  return json(summarizeMetadata(metadata));
}

async function streamPartToDisk(request, metadata, partNumber, checksum) {
  if (!request.body) {
    throw new HttpError(400, 'Part upload request must include a body.');
  }

  const offset = partNumber * metadata.chunkSize;
  const size = expectedPartSize(metadata, partNumber);
  const verifier = new VerifyingTransform(size);
  const writer = createWriteStream(tempPath(metadata.id), {
    flags: 'r+',
    start: offset
  });

  await pipeline(Readable.fromWeb(request.body), verifier, writer);

  if (verifier.bytesWritten !== size) {
    throw new HttpError(
      400,
      `Expected ${size} bytes for part ${partNumber}, received ${verifier.bytesWritten}.`
    );
  }

  const actualChecksum = verifier.digest();

  if (checksum && checksum !== actualChecksum) {
    throw new HttpError(400, `Checksum mismatch for part ${partNumber}.`);
  }

  return {
    number: partNumber,
    offset,
    size,
    checksum: actualChecksum,
    receivedAt: new Date().toISOString()
  };
}

async function handleUploadPart(request, uploadId, partNumberValue) {
  const partNumber = parseNonNegativeInt(partNumberValue, 'partNumber');
  const providedChecksum = getHeader(request, 'x-part-checksum')?.toLowerCase() ?? null;
  const providedSize = getHeader(request, 'x-part-size');
  const providedOffset = getHeader(request, 'x-upload-offset');

  const reservation = await withUploadLock(uploadId, async () => {
    const metadata = await loadMetadata(uploadId);

    if (metadata.status === 'complete') {
      throw new HttpError(409, 'Upload is already complete.');
    }

    if (partNumber >= metadata.partCount) {
      throw new HttpError(400, `partNumber must be between 0 and ${metadata.partCount - 1}.`);
    }

    const expectedSize = expectedPartSize(metadata, partNumber);
    const expectedOffset = partNumber * metadata.chunkSize;

    if (providedSize !== null && parseNonNegativeInt(providedSize, 'x-part-size') !== expectedSize) {
      throw new HttpError(400, 'x-part-size does not match the expected part size.');
    }

    if (
      providedOffset !== null &&
      parseNonNegativeInt(providedOffset, 'x-upload-offset') !== expectedOffset
    ) {
      throw new HttpError(400, 'x-upload-offset does not match the expected byte offset.');
    }

    const existingPart = metadata.uploadedParts[String(partNumber)];

    if (existingPart) {
      if (!providedChecksum || existingPart.checksum === providedChecksum) {
        return {
          alreadyUploaded: true,
          metadata
        };
      }

      throw new HttpError(409, `Part ${partNumber} already exists with a different checksum.`);
    }

    const activeSet = getActiveSet(uploadId);

    if (activeSet.has(partNumber)) {
      throw new HttpError(409, `Part ${partNumber} is already uploading.`);
    }

    activeSet.add(partNumber);

    return {
      alreadyUploaded: false,
      metadata
    };
  });

  if (reservation.alreadyUploaded) {
    return json(
      {
        status: 'already_uploaded',
        partNumber,
        ...summarizeMetadata(reservation.metadata)
      },
      200
    );
  }

  let partRecord;

  try {
    partRecord = await streamPartToDisk(request, reservation.metadata, partNumber, providedChecksum);
  } catch (error) {
    await withUploadLock(uploadId, async () => {
      releaseActivePart(uploadId, partNumber);
    });
    throw error;
  }

  const summary = await withUploadLock(uploadId, async () => {
    const metadata = await loadMetadata(uploadId);
    metadata.uploadedParts[String(partNumber)] = partRecord;
    metadata.updatedAt = new Date().toISOString();

    try {
      await storeMetadata(uploadId, metadata);
    } finally {
      releaseActivePart(uploadId, partNumber);
    }

    return summarizeMetadata(metadata);
  });

  return json(
    {
      status: 'uploaded',
      partNumber,
      partSize: partRecord.size,
      checksum: partRecord.checksum,
      ...summary
    },
    201
  );
}

async function handleCompleteUpload(uploadId) {
  const summary = await withUploadLock(uploadId, async () => {
    const metadata = await loadMetadata(uploadId);

    if (metadata.status === 'complete') {
      return summarizeMetadata(metadata);
    }

    if (!allPartsPresent(metadata)) {
      throw new HttpError(409, 'Upload is still missing one or more parts.');
    }

    const finalName = await resolveUniqueFinalName(metadata.safeFileName);
    await fs.rename(tempPath(uploadId), path.join(FINAL_ROOT, finalName));

    const now = new Date().toISOString();
    metadata.status = 'complete';
    metadata.updatedAt = now;
    metadata.completedAt = now;
    metadata.downloadUrl = `/files/${encodeURIComponent(finalName)}`;

    await storeMetadata(uploadId, metadata);
    return summarizeMetadata(metadata);
  });

  return json(
    {
      status: 'complete',
      ...summary
    },
    200
  );
}

async function handleDeleteUpload(uploadId) {
  await withUploadLock(uploadId, async () => {
    const metadata = await loadMetadata(uploadId);

    if (metadata.status === 'complete' && metadata.downloadUrl?.startsWith('/files/')) {
      const finalName = path.basename(decodeURIComponent(metadata.downloadUrl.slice('/files/'.length)));
      await fs.rm(path.join(FINAL_ROOT, finalName), { force: true });
    }

    activePartUploads.delete(uploadId);
    await fs.rm(tempPath(uploadId), { force: true });
    await fs.rm(metadataPath(uploadId), { force: true });
  });

  return empty();
}

async function serveStatic(pathname) {
  const relativePath = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  const safePath = path.normalize(path.join(PUBLIC_ROOT, relativePath));

  if (!safePath.startsWith(PUBLIC_ROOT)) {
    throw new HttpError(404, 'File not found.');
  }

  const file = Bun.file(safePath);

  if (!(await file.exists())) {
    throw new HttpError(404, 'File not found.');
  }

  return new Response(file, {
    headers: {
      'Cache-Control': 'no-store'
    }
  });
}

async function serveCompletedFile(fileNameValue) {
  const fileName = path.basename(decodeURIComponent(fileNameValue));
  const safePath = path.join(FINAL_ROOT, fileName);
  const file = Bun.file(safePath);

  if (!(await file.exists())) {
    throw new HttpError(404, 'File not found.');
  }

  return new Response(file, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${fileName.replace(/"/g, '')}"`,
      'Cache-Control': 'private, no-store'
    }
  });
}

async function route(request) {
  const url = new URL(request.url);
  const pathname = url.pathname;

  if (request.method === 'GET' && pathname === '/healthz') {
    return json({ status: 'ok' });
  }

  if (request.method === 'POST' && pathname === '/api/uploads') {
    return handleCreateUpload(request);
  }

  const partMatch = pathname.match(/^\/api\/uploads\/([^/]+)\/parts\/(\d+)$/);

  if (request.method === 'PUT' && partMatch) {
    return handleUploadPart(request, partMatch[1], partMatch[2]);
  }

  const uploadMatch = pathname.match(/^\/api\/uploads\/([^/]+)$/);

  if (request.method === 'GET' && uploadMatch) {
    return handleGetUpload(uploadMatch[1]);
  }

  if (request.method === 'DELETE' && uploadMatch) {
    return handleDeleteUpload(uploadMatch[1]);
  }

  const completeMatch = pathname.match(/^\/api\/uploads\/([^/]+)\/complete$/);

  if (request.method === 'POST' && completeMatch) {
    return handleCompleteUpload(completeMatch[1]);
  }

  const fileMatch = pathname.match(/^\/files\/(.+)$/);

  if (request.method === 'GET' && fileMatch) {
    return serveCompletedFile(fileMatch[1]);
  }

  if (request.method === 'GET') {
    return serveStatic(pathname);
  }

  throw new HttpError(404, 'Route not found.');
}

await ensureRoots();

Bun.serve({
  port: PORT,
  async fetch(request) {
    try {
      return await route(request);
    } catch (error) {
      const statusCode = error instanceof HttpError ? error.statusCode : 500;
      const payload = {
        error: error instanceof Error ? error.message : 'Unexpected server error.'
      };

      if (error instanceof HttpError && error.details) {
        payload.details = error.details;
      }

      return json(payload, statusCode);
    }
  }
});

console.log(`WoSTR Upload listening on http://localhost:${PORT}`);
