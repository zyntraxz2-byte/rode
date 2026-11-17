'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { newId, isId } = require('../util');
const { HttpError, forbidden, notFound, invalid } = require('../errors');
const { perms, isAdmin } = require('../permissions');

/** Identify an image by its magic bytes. Never trust the client-declared content type. */
function sniffImage(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  const head = buf.subarray(0, 6).toString('latin1');
  if (head === 'GIF87a' || head === 'GIF89a') return 'image/gif';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

const MAX_UNATTACHED_PER_USER = 40;
const ORPHAN_AGE_MS = 24 * 3600 * 1000;

function createAssetService({ db, config, logger }) {
  const dir = path.join(config.dataDir, 'uploads');
  fs.mkdirSync(dir, { recursive: true });
  const fileOf = (id) => path.join(dir, id);

  const row = (id) => (isId(id) ? db.prepare('SELECT * FROM assets WHERE id = ?').get(id) : undefined);

  function save(user, buffer) {
    if (!perms.canSee(user, 'inspo') || (!perms.canWrite(user, 'inspo') && !perms.isOwn(user, 'inspo'))) {
      throw forbidden('You cannot upload photos.');
    }
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw invalid('No image received.', 'file');
    if (buffer.length > config.maxUploadBytes) throw new HttpError(413, 'too_large', 'That photo is too large.');
    const mime = sniffImage(buffer);
    if (!mime) throw new HttpError(415, 'unsupported_type', 'Use JPG, PNG, WebP or GIF photos.');
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM assets WHERE owner_id = ? AND appt_id IS NULL').get(user.id);
    if (n >= MAX_UNATTACHED_PER_USER) throw new HttpError(409, 'quota_or_state', 'Too many photos waiting to be attached.');
    const id = newId();
    fs.writeFileSync(fileOf(id), buffer, { flag: 'wx', mode: 0o640 });
    try {
      db.prepare('INSERT INTO assets(id, owner_id, appt_id, position, mime, size, created_at) VALUES (?,?,NULL,0,?,?,?)')
        .run(id, user.id, mime, buffer.length, Date.now());
    } catch (e) {
      fs.rmSync(fileOf(id), { force: true });
      throw e;
    }
    return { id, mime, size: buffer.length };
  }

  /** May this user see this asset? Mirrors who can see the appointment it is attached to. */
  function canView(user, asset) {
    if (!perms.canSee(user, 'inspo')) return false;
    if (isAdmin(user) || asset.owner_id === user.id) return true;
    if (!asset.appt_id) return false;
    if (perms.canRead(user, 'inspo')) return true;
    const appt = db.prepare('SELECT owner_id FROM appts WHERE id = ?').get(asset.appt_id);
    return !!appt && appt.owner_id === user.id;
  }

  /** Resolve an asset the user may view, or throw 404 (never confirm existence to others). */
  function openForView(user, id) {
    const a = row(id);
    if (!a || !canView(user, a)) throw notFound();
    const file = fileOf(a.id);
    if (!fs.existsSync(file)) throw notFound();
    return { file, mime: a.mime, size: a.size };
  }

  /** Delete an unattached upload (owner or admin). */
  function discard(user, id) {
    const a = row(id);
    if (!a || (a.owner_id !== user.id && !isAdmin(user))) throw notFound();
    if (a.appt_id) throw new HttpError(409, 'attached', 'Remove the photo from its booking instead.');
    db.prepare('DELETE FROM assets WHERE id = ?').run(id);
    unlinkFiles([id]);
  }

  function unlinkFiles(ids) {
    for (const id of ids) {
      if (!isId(id)) continue;
      try { fs.rmSync(fileOf(id), { force: true }); } catch (e) { logger.warn('asset.unlink_failed', { id, err: e.message }); }
    }
  }

  /** Remove uploads that were never attached to a booking, plus rows whose files vanished. */
  function sweepOrphans() {
    const old = db.prepare('SELECT id FROM assets WHERE appt_id IS NULL AND created_at < ?').all(Date.now() - ORPHAN_AGE_MS).map((r) => r.id);
    if (old.length) {
      db.transaction(() => { for (const id of old) db.prepare('DELETE FROM assets WHERE id = ?').run(id); })();
      unlinkFiles(old);
    }
    return old.length;
  }

  return { save, openForView, discard, unlinkFiles, sweepOrphans, row, sniffImage };
}

module.exports = { createAssetService, sniffImage };
