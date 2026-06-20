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

const eventIndex = [];
const offsets = new Map();
const partialLines = new Map();

await mkdir(eventsDir, { recursive: true, mode: 0o700 });
await initializeEventIndex();
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

async function initializeEventIndex() {
  for (const file of await listEventFiles()) {
    const filePath = path.join(eventsDir, file);
    const fileStat = await stat(filePath);
    const indexedEvents = await indexEventFile(file, 0, fileStat.size, emptyPartialLine());
    offsets.set(filePath, fileStat.size);
    partialLines.set(filePath, indexedEvents.partialLine);
  }
}

async function pollEventFiles() {
  for (const file of await listEventFiles()) {
    const filePath = path.join(eventsDir, file);
    const fileStat = await stat(filePath);
    const previousOffset = offsets.get(filePath) ?? 0;

    if (fileStat.size < previousOffset) {
      removeIndexedEventsForFile(filePath);
      offsets.set(filePath, 0);
      partialLines.set(filePath, emptyPartialLine());
    }

    const offset = offsets.get(filePath) ?? 0;
    if (fileStat.size === offset) {
      continue;
    }

    const indexedEvents = await indexEventFile(
      file,
      offset,
      fileStat.size,
      partialLines.get(filePath) ?? emptyPartialLine(),
      true
    );
    offsets.set(filePath, fileStat.size);
    partialLines.set(filePath, indexedEvents.partialLine);

    for (const indexedEvent of indexedEvents.events) {
      broadcast({
        type: 'patrol.event.appended',
        stream: indexedEvent.stream,
        file: indexedEvent.file,
        event: indexedEvent.event
      });
    }
  }
}

async function sendCatchUpEvents(socket, cursor) {
  if (!cursor) {
    return;
  }

  const events = eventIndex.filter(({ event }) => eventAfterCursor(event, cursor));

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

async function indexEventFile(file, start, end, partialLine, emitParseErrors = false) {
  if (end <= start) {
    return {
      events: [],
      partialLine
    };
  }

  const filePath = path.join(eventsDir, file);
  const stream = streamFromFile(file);
  const events = [];
  let buffer = partialLine.buffer;
  let lineStart = buffer.length > 0 ? partialLine.startOffset : start;

  for await (const chunk of createReadStream(filePath, {
    start,
    end: end - 1
  })) {
    buffer = Buffer.concat([buffer, chunk]);

    let newlineIndex = buffer.indexOf(10);
    while (newlineIndex !== -1) {
      const lineBuffer = buffer.subarray(0, newlineIndex);
      const lineEnd = lineStart + lineBuffer.length + 1;
      const indexedEvent = indexEventLine({
        file,
        filePath,
        stream,
        lineBuffer,
        startOffset: lineStart,
        endOffset: lineEnd,
        emitParseErrors
      });

      if (indexedEvent) {
        events.push(indexedEvent);
      }

      buffer = buffer.subarray(newlineIndex + 1);
      lineStart = lineEnd;
      newlineIndex = buffer.indexOf(10);
    }
  }

  return {
    events,
    partialLine: {
      buffer,
      startOffset: lineStart
    }
  };
}

function indexEventLine(input) {
  const line = input.lineBuffer.toString('utf8');
  if (!line.trim()) {
    return null;
  }

  try {
    const event = JSON.parse(line);
    const indexedEvent = {
      stream: input.stream,
      file: input.file,
      filePath: input.filePath,
      startOffset: input.startOffset,
      endOffset: input.endOffset,
      event
    };
    eventIndex.push(indexedEvent);
    return indexedEvent;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (input.emitParseErrors) {
      broadcast({
        type: 'patrol.event.parse_error',
        file: input.file,
        line,
        message,
        ts_ms: Date.now()
      });
    } else {
      console.warn(`skipping unparsable event line in ${input.file}: ${message}`);
    }
    return null;
  }
}

function removeIndexedEventsForFile(filePath) {
  for (let index = eventIndex.length - 1; index >= 0; index -= 1) {
    if (eventIndex[index].filePath === filePath) {
      eventIndex.splice(index, 1);
    }
  }
}

function emptyPartialLine() {
  return {
    buffer: Buffer.alloc(0),
    startOffset: 0
  };
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
