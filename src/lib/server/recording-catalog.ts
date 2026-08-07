import { createReadStream } from 'node:fs';
import { mkdir, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import type { RecordingSegment, RecordingStreamRole } from '$lib/cameras/discovery';
import type { PatrolEvent } from '$lib/events';

export interface CatalogSegmentInput {
  cameraId: string;
  role: RecordingStreamRole;
  streamName: string;
  startMs: number;
  durationMs: number;
  sizeBytes: number;
  relativePath: string;
  observedAtMs: number;
}

interface RecordingSegmentObservedPayload {
  cameraId: string;
  role: RecordingStreamRole;
  streamName: string;
  startMs: number;
  durationMs: number;
  sizeBytes: number;
  relativePath: string;
}

interface RecordingSegmentExpiredPayload {
  relativePath: string;
}

interface RecordingSegmentRelocatedPayload extends RecordingSegmentObservedPayload {
  previousRelativePath: string;
  previousSizeBytes: number;
}

interface CatalogRow {
  camera_id: string;
  role: RecordingStreamRole;
  stream_name: string;
  start_ms: number;
  end_ms: number;
  duration_ms: number;
  size_bytes: number;
  relative_path: string;
  observed_at_ms: number;
}

export interface CatalogThumbnailCandidate {
  relativePath: string;
  startMs: number;
}

export interface CatalogThumbnailCleanup {
  relativePath: string;
  thumbnailRelativePath: string | null;
}

const CATALOG_FILE_NAME = 'recording-catalog.sqlite';

export class RecordingCatalog {
  readonly #database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.#database = database;
  }

  close() {
    this.#database.close();
  }

  hasSegment(relativePath: string) {
    return Boolean(
      this.#database
        .prepare('SELECT 1 AS present FROM recording_segments WHERE relative_path = ? LIMIT 1')
        .get(relativePath)
    );
  }

  segmentForPath(relativePath: string): RecordingSegment | null {
    const row = this.#database.prepare(`
      SELECT camera_id, role, stream_name, start_ms, end_ms, duration_ms,
             size_bytes, relative_path, observed_at_ms
      FROM recording_segments
      WHERE relative_path = ?
      LIMIT 1
    `).get(relativePath) as CatalogRow | undefined;
    return row ? segmentFromRow(row) : null;
  }

  upsertSegment(segment: CatalogSegmentInput) {
    this.#database.prepare(`
      INSERT INTO recording_segments (
        relative_path, camera_id, role, stream_name, start_ms, end_ms,
        duration_ms, size_bytes, observed_at_ms, expired_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(relative_path) DO UPDATE SET
        camera_id = excluded.camera_id,
        role = excluded.role,
        stream_name = excluded.stream_name,
        start_ms = excluded.start_ms,
        end_ms = excluded.end_ms,
        duration_ms = excluded.duration_ms,
        size_bytes = excluded.size_bytes,
        observed_at_ms = MAX(recording_segments.observed_at_ms, excluded.observed_at_ms)
    `).run(
      segment.relativePath,
      segment.cameraId,
      segment.role,
      segment.streamName,
      segment.startMs,
      segment.startMs + segment.durationMs,
      segment.durationMs,
      segment.sizeBytes,
      segment.observedAtMs
    );
  }

  relocateSegment(previousRelativePath: string, segment: CatalogSegmentInput) {
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      this.#relocateSegment(previousRelativePath, segment);
      this.#database.exec('COMMIT');
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
  }

  #relocateSegment(previousRelativePath: string, segment: CatalogSegmentInput) {
    if (previousRelativePath === segment.relativePath) {
      this.upsertSegment(segment);
      return;
    }
    this.upsertSegment(segment);
    this.#database
      .prepare('UPDATE recording_thumbnails SET relative_path = ? WHERE relative_path = ?')
      .run(segment.relativePath, previousRelativePath);
    this.#database.prepare('DELETE FROM recording_segments WHERE relative_path = ?').run(previousRelativePath);
  }

  expireSegment(relativePath: string, expiredAtMs = Date.now()) {
    this.#database
      .prepare('UPDATE recording_segments SET expired_at_ms = ? WHERE relative_path = ?')
      .run(expiredAtMs, relativePath);
  }

  segmentsForWindow(streamNames: string[], startMs: number, endMs: number): RecordingSegment[] {
    if (streamNames.length === 0) {
      return [];
    }
    const placeholders = streamNames.map(() => '?').join(', ');
    const rows = this.#database.prepare(`
      SELECT camera_id, role, stream_name, start_ms, end_ms, duration_ms,
             size_bytes, relative_path, observed_at_ms
      FROM recording_segments INDEXED BY recording_segments_active_end_window
      WHERE expired_at_ms IS NULL
        AND stream_name IN (${placeholders})
        AND start_ms <= ?
        AND end_ms >= ?
      ORDER BY start_ms DESC, relative_path ASC
    `).all(...streamNames, endMs, startMs) as unknown as CatalogRow[];
    return rows.map(segmentFromRow);
  }

  availableBounds(streamNames: string[]) {
    if (streamNames.length === 0) {
      return { availableStartMs: null, availableEndMs: null };
    }
    const placeholders = streamNames.map(() => '?').join(', ');
    const startRow = this.#database.prepare(`
      SELECT start_ms AS available_start_ms
      FROM recording_segments INDEXED BY recording_segments_active_window
      WHERE expired_at_ms IS NULL
        AND stream_name IN (${placeholders})
      ORDER BY start_ms ASC
      LIMIT 1
    `).get(...streamNames) as { available_start_ms: number } | undefined;
    const endRow = this.#database.prepare(`
      SELECT end_ms AS available_end_ms
      FROM recording_segments INDEXED BY recording_segments_active_end_window
      WHERE expired_at_ms IS NULL
        AND stream_name IN (${placeholders})
      ORDER BY end_ms DESC
      LIMIT 1
    `).get(...streamNames) as { available_end_ms: number } | undefined;
    return {
      availableStartMs: startRow?.available_start_ms ?? null,
      availableEndMs: endRow?.available_end_ms ?? null
    };
  }

  summary() {
    const row = this.#database.prepare(`
      SELECT COUNT(*) AS total_segments,
             SUM(CASE WHEN expired_at_ms IS NULL THEN 1 ELSE 0 END) AS active_segments,
             MIN(CASE WHEN expired_at_ms IS NULL THEN start_ms END) AS available_start_ms,
             MAX(CASE WHEN expired_at_ms IS NULL THEN end_ms END) AS available_end_ms
      FROM recording_segments
    `).get() as {
      total_segments: number;
      active_segments: number;
      available_start_ms: number | null;
      available_end_ms: number | null;
    };
    return { ...row };
  }

  segmentsPastRetention(mainBeforeMs: number, subBeforeMs: number): RecordingSegment[] {
    const rows = this.#database.prepare(`
      SELECT camera_id, role, stream_name, start_ms, end_ms, duration_ms,
             size_bytes, relative_path, observed_at_ms
      FROM recording_segments
      WHERE expired_at_ms IS NULL
        AND ((role = 'main' AND start_ms < ?) OR (role = 'sub' AND start_ms < ?))
      ORDER BY start_ms ASC, relative_path ASC
    `).all(mainBeforeMs, subBeforeMs) as unknown as CatalogRow[];
    return rows.map(segmentFromRow);
  }

  segmentsNeedingThumbnails(retainedAfterMs: number, nowMs: number, limit: number): CatalogThumbnailCandidate[] {
    const rows = this.#database.prepare(`
      SELECT segments.relative_path, segments.start_ms
      FROM recording_segments AS segments INDEXED BY recording_segments_active_role_start
      LEFT JOIN recording_thumbnails AS thumbnails
        ON thumbnails.relative_path = segments.relative_path
      WHERE segments.expired_at_ms IS NULL
        AND segments.role = 'main'
        AND segments.start_ms >= ?
        AND thumbnails.thumbnail_relative_path IS NULL
        AND COALESCE(thumbnails.retry_after_ms, 0) <= ?
      ORDER BY segments.start_ms DESC, segments.relative_path ASC
      LIMIT ?
    `).all(retainedAfterMs, nowMs, limit) as unknown as Array<{
      relative_path: string;
      start_ms: number;
    }>;
    return rows.map((row) => ({ relativePath: row.relative_path, startMs: row.start_ms }));
  }

  markThumbnailGenerated(
    relativePath: string,
    thumbnailRelativePath: string,
    sizeBytes: number,
    generatedAtMs = Date.now()
  ) {
    this.#database.prepare(`
      INSERT INTO recording_thumbnails (
        relative_path, thumbnail_relative_path, generated_at_ms, size_bytes,
        attempt_count, last_error, retry_after_ms
      ) VALUES (?, ?, ?, ?, 1, NULL, NULL)
      ON CONFLICT(relative_path) DO UPDATE SET
        thumbnail_relative_path = excluded.thumbnail_relative_path,
        generated_at_ms = excluded.generated_at_ms,
        size_bytes = excluded.size_bytes,
        attempt_count = recording_thumbnails.attempt_count + 1,
        last_error = NULL,
        retry_after_ms = NULL
    `).run(relativePath, thumbnailRelativePath, generatedAtMs, sizeBytes);
  }

  markThumbnailFailed(relativePath: string, message: string, retryAfterMs: number) {
    this.#database.prepare(`
      INSERT INTO recording_thumbnails (
        relative_path, thumbnail_relative_path, generated_at_ms, size_bytes,
        attempt_count, last_error, retry_after_ms
      ) VALUES (?, NULL, NULL, NULL, 1, ?, ?)
      ON CONFLICT(relative_path) DO UPDATE SET
        thumbnail_relative_path = NULL,
        generated_at_ms = NULL,
        size_bytes = NULL,
        attempt_count = recording_thumbnails.attempt_count + 1,
        last_error = excluded.last_error,
        retry_after_ms = excluded.retry_after_ms
    `).run(relativePath, message.slice(0, 1000), retryAfterMs);
  }

  thumbnailRecordsPastRetention(retainedAfterMs: number, limit: number): CatalogThumbnailCleanup[] {
    const rows = this.#database.prepare(`
      SELECT thumbnails.relative_path, thumbnails.thumbnail_relative_path
      FROM recording_thumbnails AS thumbnails
      JOIN recording_segments AS segments ON segments.relative_path = thumbnails.relative_path
      WHERE segments.expired_at_ms IS NOT NULL OR segments.start_ms < ?
      ORDER BY segments.start_ms ASC, thumbnails.relative_path ASC
      LIMIT ?
    `).all(retainedAfterMs, limit) as unknown as Array<{
      relative_path: string;
      thumbnail_relative_path: string | null;
    }>;
    return rows.map((row) => ({
      relativePath: row.relative_path,
      thumbnailRelativePath: row.thumbnail_relative_path
    }));
  }

  deleteThumbnail(relativePath: string) {
    this.#database.prepare('DELETE FROM recording_thumbnails WHERE relative_path = ?').run(relativePath);
  }

  resetGeneratedThumbnails() {
    this.#database.prepare(`
      UPDATE recording_thumbnails
      SET thumbnail_relative_path = NULL,
          generated_at_ms = NULL,
          size_bytes = NULL,
          retry_after_ms = NULL
      WHERE thumbnail_relative_path IS NOT NULL
    `).run();
  }

  thumbnailSummary() {
    const row = this.#database.prepare(`
      SELECT COUNT(*) AS tracked,
             SUM(CASE WHEN thumbnail_relative_path IS NOT NULL THEN 1 ELSE 0 END) AS generated,
             SUM(CASE WHEN last_error IS NOT NULL THEN 1 ELSE 0 END) AS failed
      FROM recording_thumbnails
    `).get() as { tracked: number; generated: number; failed: number };
    return { ...row };
  }

  applyEvents(events: PatrolEvent[]) {
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      for (const event of events) {
        if (event.type === 'recording.segment.observed') {
          const payload = event.payload as RecordingSegmentObservedPayload;
          if (payload.sizeBytes > 0) {
            this.upsertSegment({ ...payload, observedAtMs: event.ts_ms });
          }
        } else if (event.type === 'recording.segment.expired') {
          const payload = event.payload as RecordingSegmentExpiredPayload;
          this.expireSegment(payload.relativePath, event.ts_ms);
        } else if (event.type === 'recording.segment.relocated') {
          const payload = event.payload as RecordingSegmentRelocatedPayload;
          this.#relocateSegment(payload.previousRelativePath, { ...payload, observedAtMs: event.ts_ms });
        }
      }
      this.#database.exec('COMMIT');
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
  }

  syncPosition() {
    const rows = this.#database
      .prepare("SELECT key, value FROM recording_catalog_meta WHERE key IN ('event_file', 'event_offset')")
      .all() as unknown as Array<{ key: string; value: string }>;
    const values = Object.fromEntries(rows.map(({ key, value }) => [key, value]));
    return {
      file: values.event_file ?? null,
      offset: Number(values.event_offset ?? 0) || 0
    };
  }

  setSyncPosition(file: string, offset: number) {
    const statement = this.#database.prepare(`
      INSERT INTO recording_catalog_meta (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      statement.run('event_file', file);
      statement.run('event_offset', String(offset));
      this.#database.exec('COMMIT');
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
  }
}

export async function openRecordingCatalog(dataRoot: string) {
  const cacheDir = path.join(dataRoot, 'cache');
  await mkdir(cacheDir, { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(path.join(cacheDir, CATALOG_FILE_NAME));
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS recording_segments (
      relative_path TEXT PRIMARY KEY,
      camera_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('main', 'sub')),
      stream_name TEXT NOT NULL,
      start_ms INTEGER NOT NULL,
      end_ms INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL,
      size_bytes INTEGER NOT NULL,
      observed_at_ms INTEGER NOT NULL,
      expired_at_ms INTEGER
    );
    CREATE INDEX IF NOT EXISTS recording_segments_active_window
      ON recording_segments (start_ms, end_ms) WHERE expired_at_ms IS NULL;
    CREATE INDEX IF NOT EXISTS recording_segments_active_stream_window
      ON recording_segments (stream_name, start_ms, end_ms) WHERE expired_at_ms IS NULL;
    CREATE INDEX IF NOT EXISTS recording_segments_active_end_window
      ON recording_segments (end_ms, start_ms, stream_name) WHERE expired_at_ms IS NULL;
    CREATE INDEX IF NOT EXISTS recording_segments_active_role_start
      ON recording_segments (role, start_ms DESC, relative_path) WHERE expired_at_ms IS NULL;
    CREATE TABLE IF NOT EXISTS recording_thumbnails (
      relative_path TEXT PRIMARY KEY REFERENCES recording_segments(relative_path),
      thumbnail_relative_path TEXT,
      generated_at_ms INTEGER,
      size_bytes INTEGER,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      retry_after_ms INTEGER
    );
    CREATE TABLE IF NOT EXISTS recording_catalog_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  return new RecordingCatalog(database);
}

export async function syncRecordingCatalogFromEvents(catalog: RecordingCatalog, eventsDir: string) {
  let entries: string[];
  try {
    entries = await readdir(eventsDir);
  } catch {
    return { filesRead: 0, eventsApplied: 0 };
  }

  const files = entries.filter((entry) => /^cameras-\d{4}-\d{2}-\d{2}\.jsonl$/.test(entry)).sort();
  const position = catalog.syncPosition();
  let filesRead = 0;
  let eventsApplied = 0;

  for (const file of files) {
    if (position.file && file < position.file) {
      continue;
    }

    const filePath = path.join(eventsDir, file);
    const fileStat = await stat(filePath);
    const requestedOffset = file === position.file ? position.offset : 0;
    const startOffset = requestedOffset >= 0 && requestedOffset <= fileStat.size ? requestedOffset : 0;
    if (startOffset === fileStat.size) {
      catalog.setSyncPosition(file, fileStat.size);
      continue;
    }

    const batch: PatrolEvent[] = [];
    const input = createReadStream(filePath, { start: startOffset, end: fileStat.size - 1 });
    const lines = createInterface({ input, crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      try {
        const event = JSON.parse(line) as PatrolEvent;
        if (
          event.type === 'recording.segment.observed' ||
          event.type === 'recording.segment.expired' ||
          event.type === 'recording.segment.relocated'
        ) {
          batch.push(event);
          if (batch.length >= 5000) {
            catalog.applyEvents(batch.splice(0));
          }
          eventsApplied += 1;
        }
      } catch {
        // Ignore a malformed final or historical event line and continue the catalog sync.
      }
    }
    if (batch.length > 0) {
      catalog.applyEvents(batch);
    }
    catalog.setSyncPosition(file, fileStat.size);
    filesRead += 1;
  }

  return { filesRead, eventsApplied };
}

function segmentFromRow(row: CatalogRow): RecordingSegment {
  return {
    cameraId: row.camera_id,
    role: row.role,
    streamName: row.stream_name,
    startMs: row.start_ms,
    endMs: row.end_ms,
    durationMs: row.duration_ms,
    sizeBytes: row.size_bytes,
    relativePath: row.relative_path,
    observedAtMs: row.observed_at_ms
  };
}
