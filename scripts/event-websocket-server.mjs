import { createReadStream } from 'node:fs';
import { mkdir, readdir, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { startProcessHeartbeats } from './lib/patrol-events.mjs';

const dataRoot = process.env.PATROL_DATA_DIR ?? path.join(process.cwd(), '.patrol');
const eventsDir = path.join(dataRoot, 'events');
const host = process.env.PATROL_EVENTS_WS_HOST ?? '0.0.0.0';
const port = Number(process.env.PATROL_EVENTS_WS_PORT ?? '5186');
const pollMs = Number(process.env.PATROL_EVENTS_WS_POLL_MS ?? '500');
const streams = (process.env.PATROL_EVENTS_WS_STREAMS ?? 'cameras,system')
  .split(',')
  .map((stream) => stream.trim())
  .filter(Boolean);

const offsets = new Map();
const partialLines = new Map();

await mkdir(eventsDir, { recursive: true, mode: 0o700 });
await initializeOffsets();
startProcessHeartbeats({
  processId: 'patrol-events-ws',
  label: 'Event WebSocket server',
  kind: 'server',
  detail: `Streams ${streams.join(', ')} event log appends to browser clients`
});

const httpServer = createServer((request, response) => {
  if (request.url === '/healthz') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true, streams }));
    return;
  }

  response.writeHead(404, { 'content-type': 'text/plain' });
  response.end('not found\n');
});

const wss = new WebSocketServer({ server: httpServer, path: '/ws/events' });

wss.on('connection', (socket, request) => {
  const cursor = cursorFromRequest(request);
  send(socket, {
    type: 'patrol.event_stream.connected',
    ts_ms: Date.now(),
    streams,
    cursor
  });

  void sendCatchUpEvents(socket, cursor).catch((error) => {
    send(socket, {
      type: 'patrol.event_stream.catch_up_error',
      ts_ms: Date.now(),
      message: error instanceof Error ? error.message : String(error)
    });
  });
});

setInterval(() => {
  broadcast({
    type: 'patrol.event_stream.heartbeat',
    ts_ms: Date.now()
  });
}, 30000).unref();

setInterval(() => {
  void pollEventFiles().catch((error) => {
    console.error('event websocket poll failed:', error);
  });
}, pollMs).unref();

httpServer.listen(port, host, () => {
  console.log(`patrol event websocket listening on ws://${host}:${port}/ws/events`);
  console.log(`tailing ${eventsDir} for streams: ${streams.join(', ')}`);
});

async function initializeOffsets() {
  for (const file of await listEventFiles()) {
    const filePath = path.join(eventsDir, file);
    const fileStat = await stat(filePath);
    offsets.set(filePath, fileStat.size);
    partialLines.set(filePath, '');
  }
}

async function pollEventFiles() {
  for (const file of await listEventFiles()) {
    const filePath = path.join(eventsDir, file);
    const fileStat = await stat(filePath);
    const previousOffset = offsets.get(filePath) ?? 0;

    if (fileStat.size < previousOffset) {
      offsets.set(filePath, 0);
      partialLines.set(filePath, '');
    }

    const offset = offsets.get(filePath) ?? 0;
    if (fileStat.size === offset) {
      continue;
    }

    const chunk = await readRange(filePath, offset, fileStat.size);
    offsets.set(filePath, fileStat.size);

    const buffered = `${partialLines.get(filePath) ?? ''}${chunk}`;
    const lines = buffered.split('\n');
    partialLines.set(filePath, lines.pop() ?? '');

    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }

      try {
        const event = JSON.parse(line);
        broadcast({
          type: 'patrol.event.appended',
          stream: streamFromFile(file),
          file,
          event
        });
      } catch (error) {
        broadcast({
          type: 'patrol.event.parse_error',
          file,
          line,
          message: error instanceof Error ? error.message : String(error),
          ts_ms: Date.now()
        });
      }
    }
  }
}

async function sendCatchUpEvents(socket, cursor) {
  if (!cursor) {
    return;
  }

  const events = [];
  for (const file of await listEventFiles()) {
    const stream = streamFromFile(file);
    const filePath = path.join(eventsDir, file);
    const chunk = await readRange(filePath, 0, (await stat(filePath)).size);
    for (const line of chunk.split('\n')) {
      if (!line.trim()) {
        continue;
      }

      const event = JSON.parse(line);
      if (eventAfterCursor(event, cursor)) {
        events.push({ stream, file, event });
      }
    }
  }

  events.sort((left, right) => compareEvents(left.event, right.event) || left.stream.localeCompare(right.stream));

  for (const { stream, file, event } of events) {
    send(socket, {
      type: 'patrol.event.appended',
      stream,
      file,
      event,
      catchUp: true
    });
  }

  send(socket, {
    type: 'patrol.event_stream.catch_up_completed',
    ts_ms: Date.now(),
    sent: events.length
  });
}

async function listEventFiles() {
  const entries = await readdir(eventsDir);
  return entries
    .filter((entry) => streams.some((stream) => entry.startsWith(`${stream}-`)))
    .filter((entry) => entry.endsWith('.jsonl'))
    .sort();
}

function readRange(filePath, start, end) {
  return new Promise((resolve, reject) => {
    let content = '';
    const stream = createReadStream(filePath, {
      encoding: 'utf8',
      start,
      end: end - 1
    });
    stream.on('data', (chunk) => {
      content += chunk;
    });
    stream.on('error', reject);
    stream.on('end', () => resolve(content));
  });
}

function streamFromFile(file) {
  for (const stream of streams) {
    if (file.startsWith(`${stream}-`)) {
      return stream;
    }
  }

  return 'unknown';
}

function cursorFromRequest(request) {
  const requestUrl = new URL(request.url ?? '/ws/events', `http://${request.headers.host ?? 'localhost'}`);
  const tsMs = Number(requestUrl.searchParams.get('after_ts_ms'));
  const id = requestUrl.searchParams.get('after_id');
  if (!Number.isFinite(tsMs) || !id) {
    return null;
  }
  return {
    ts_ms: tsMs,
    id
  };
}

function eventAfterCursor(event, cursor) {
  return event.ts_ms > cursor.ts_ms || (event.ts_ms === cursor.ts_ms && event.id > cursor.id);
}

function compareEvents(left, right) {
  return left.ts_ms - right.ts_ms || left.id.localeCompare(right.id);
}

function broadcast(message) {
  const data = JSON.stringify(message);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

function send(socket, message) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}
