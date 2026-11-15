// Photo memory: a local image is added by the user, Bonsai vision extracts compact
// observations, the observations are indexed with Bonsai embeddings + FTS, and later
// answers cite the original photo as evidence. The image never leaves the device.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { json, now, tx } from './db.mjs';
import { indexMemories } from './embeddings.mjs';
import { resolveMode } from './capabilities.mjs';
import { resolveWhen } from './temporal.mjs';
import { isValidPersonName, displayName } from './names.mjs';
import { findPersonByName, upsertPerson } from './identity.mjs';

const MAX_BYTES = 12 * 1024 * 1024;
const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.heic': 'image/heic', '.gif': 'image/gif' };
const ROOT = path.resolve(import.meta.dirname, '../..');
const PHOTO_DIR = path.join(ROOT, 'data/photos');
const UPLOAD_DIR = path.join(ROOT, 'data/uploads');

/** Trust the bytes, not the browser's Content-Type. */
function sniffImageExt(buf) {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return '.png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return '.webp';
  if (buf.length >= 6 && buf.toString('ascii', 0, 3) === 'GIF') return '.gif';
  return null;
}

const VISION_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['caption', 'observations'],
  properties: {
    caption: { type: 'string', maxLength: 300 },
    observations: { type: 'array', maxItems: 8, items: { type: 'object', additionalProperties: false, required: ['kind', 'text', 'confidence'],
      properties: {
        kind: { type: 'string', enum: ['person', 'place', 'object', 'text', 'activity', 'pet', 'document', 'other'] },
        text: { type: 'string', maxLength: 160 },
        confidence: { type: 'number' },
      } } },
  },
};

const VISION_SYSTEM = `You describe one personal photo so its owner can find it later from memory. The owner may have memory loss.
Return JSON:
- caption: one short factual sentence about the photo.
- observations: up to eight things that are clearly visible. kind is person, place, object, text, activity, pet, document or other. text is a short, concrete phrase ("blue birthday cake", "sign says Main Street Pharmacy"). confidence is 0 to 1.
Only describe what you can see. Never guess a person's name unless a name is written in the image; say "a woman" instead. No speculation, no feelings, no invented dates.`;

const ANSWER_SCHEMA = { type: 'object', additionalProperties: false, required: ['answer', 'visible'], properties: {
  answer: { type: 'string', maxLength: 300 }, visible: { type: 'boolean' },
} };

function mimeOf(file) {
  const ext = path.extname(file).toLowerCase();
  return MIME[ext] ?? 'application/octet-stream';
}

/** Copy the image into the local evidence store and return its data URI. */
function stageImage(file) {
  const abs = path.isAbsolute(file) ? file : path.resolve(ROOT, file);
  if (!existsSync(abs)) throw new Error(`photo not found: ${file}`);
  const info = statSync(abs);
  if (!info.isFile()) throw new Error(`not a file: ${file}`);
  if (info.size > MAX_BYTES) throw new Error(`photo too large (${Math.round(info.size / 1e6)} MB, max ${MAX_BYTES / 1e6} MB)`);
  const mime = mimeOf(abs);
  if (!mime.startsWith('image/')) throw new Error(`unsupported image type: ${path.extname(abs) || '(none)'}`);
  const bytes = readFileSync(abs);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  mkdirSync(PHOTO_DIR, { recursive: true });
  const stored = path.join(PHOTO_DIR, `${sha256.slice(0, 16)}${path.extname(abs).toLowerCase()}`);
  if (!existsSync(stored)) copyFileSync(abs, stored);
  return { abs, stored, sha256, mime, bytes, dataUri: `data:${mime};base64,${bytes.toString('base64')}` };
}

/**
 * Add one local photo: Bonsai vision → grounded observations → FTS + Bonsai vectors.
 * `people` may be supplied by the user ("this is Maya and Priya") and is validated like any name.
 */
export async function ingestPhoto(db, bonsai, { file, note = null, takenAt = null, people = [] } = {}) {
  if (!file) throw new Error('file is required');
  const img = stageImage(file);
  const existing = db.prepare('SELECT * FROM photos WHERE sha256 = ?').get(img.sha256);
  if (existing) {
    const observations = db.prepare('SELECT rowid, kind, text, confidence FROM photo_observations WHERE photo_id = ?').all(existing.id);
    return { photo: existing, observations, duplicate: true, indexed: 0, mode: 'unchanged' };
  }

  const out = await bonsai.vision({ name: 'photo_extract', system: VISION_SYSTEM, schema: VISION_SCHEMA, user: 'Describe this photo for the owner\'s memory.', image: img.dataUri });
  const caption = (out.caption ?? '').trim();
  if (!caption) throw new Error('Bonsai vision returned an empty caption');
  const observations = (out.observations ?? [])
    .map((o) => ({ kind: o.kind ?? 'other', text: String(o.text ?? '').trim(), confidence: Math.max(0, Math.min(1, Number(o.confidence) || 0)) }))
    .filter((o) => o.text.length >= 3 && o.confidence >= 0.3);

  const id = `ph_${img.sha256.slice(0, 12)}`;
  const mode = await resolveMode(bonsai);
  tx(db, () => {
    db.prepare('INSERT INTO photos (id, path, sha256, mime, taken_at, added_at, caption) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, path.relative(ROOT, img.stored), img.sha256, img.mime, takenAt ? resolveWhen(takenAt, takenAt) ?? takenAt : null, now(), note ?? caption);
    for (const o of observations) {
      const r = db.prepare('INSERT INTO photo_observations (photo_id, kind, text, confidence, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, o.kind, o.text, o.confidence, now());
      db.prepare('INSERT INTO photo_observations_fts (rowid, text) VALUES (?, ?)').run(r.lastInsertRowid, o.text);
    }
    for (const name of people) {
      const cleaned = displayName(name);
      if (!isValidPersonName(cleaned)) continue;
      const pid = findPersonByName(db, cleaned)?.id ?? upsertPerson(db, { name: cleaned });
      db.prepare('INSERT OR IGNORE INTO photo_people (photo_id, person_id, role) VALUES (?, ?, ?)').run(id, pid, 'hint');
    }
  });

  let indexed = 0;
  if (mode.mode !== 'bm25') {
    const result = await indexMemories(db, bonsai);
    indexed = result.indexed;
  }
  return {
    photo: db.prepare('SELECT * FROM photos WHERE id = ?').get(id),
    observations: db.prepare('SELECT rowid, kind, text, confidence FROM photo_observations WHERE photo_id = ?').all(id),
    caption, duplicate: false, indexed, mode: mode.mode,
  };
}

/**
 * Browser upload path: the page cannot give us a filesystem path, so it posts the bytes.
 * The bytes are sniffed, written to the ignored data/uploads dir, and handed to the same
 * ingestPhoto pipeline (dedupe by SHA-256, Bonsai vision, FTS + vectors).
 */
export async function uploadPhoto(db, bonsai, { buffer, mime = '', note = null, takenAt = null, people = [] } = {}) {
  if (!buffer?.length) throw Object.assign(new Error('empty upload'), { statusCode: 400 });
  if (buffer.length > MAX_BYTES) throw Object.assign(new Error(`photo too large (max ${MAX_BYTES / 1e6} MB)`), { statusCode: 413 });
  if (mime && !mime.startsWith('image/')) throw Object.assign(new Error(`unsupported image type: ${mime}`), { statusCode: 415 });
  const ext = sniffImageExt(buffer);
  if (!ext) throw Object.assign(new Error('unsupported image type (PNG, JPEG, WebP or GIF)'), { statusCode: 415 });
  mkdirSync(UPLOAD_DIR, { recursive: true });
  const tmp = path.join(UPLOAD_DIR, `upload-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  writeFileSync(tmp, buffer);
  try {
    return await ingestPhoto(db, bonsai, { file: tmp, note, takenAt, people });
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** Photos that a recall answer cited (refs look like O12). */
export function observationsForRefs(db, refs) {
  return refs
    .map((ref) => (/^O\d+$/.test(ref) ? db.prepare('SELECT o.rowid, o.kind, o.text, o.photo_id, p.path, p.caption FROM photo_observations o JOIN photos p ON p.id = o.photo_id WHERE o.rowid = ?').get(Number(ref.slice(1))) : null))
    .filter(Boolean);
}

export function photoFor(db, id) {
  return db.prepare('SELECT id, path, mime, taken_at, added_at, caption FROM photos WHERE id = ?').get(id) ?? null;
}

/** Reinspect stored pixels when the initial observations did not capture a detail. */
export async function askPhoto(db, bonsai, id, question) {
  const photo = photoFor(db, id);
  if (!photo) throw new Error(`photo not found: ${id}`);
  const file = path.resolve(ROOT, photo.path);
  if (!file.startsWith(`${PHOTO_DIR}${path.sep}`) || !existsSync(file)) throw new Error('stored photo is unavailable');
  const dataUri = `data:${photo.mime};base64,${readFileSync(file).toString('base64')}`;
  const out = await bonsai.vision({ name: 'photo_answer', schema: ANSWER_SCHEMA,
    system: 'Answer the question using only what is visible in this photo. Read labels carefully. If the requested detail is not visible or legible, say you cannot tell from this photo and set visible to false. Do not use outside knowledge or guess.',
    user: question, image: dataUri, maxTokens: 300 });
  const visible = out.visible === true && !!String(out.answer ?? '').trim();
  return { answer: visible ? out.answer.trim() : 'I cannot tell from this photo.',
    cites: visible ? [`PHOTO:${id}`] : [], clips: [], photos: [photo], grounded: visible,
    trace: [{ step: 0, action: 'photo_vision', photoId: id, visible }], mode: 'vision' };
}
