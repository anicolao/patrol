const DEFAULT_GO2RTC_STREAMS_URL = 'http://127.0.0.1:1984/api/streams';
const DEFAULT_DISCOVERY_URL = 'http://127.0.0.1:5184/api/cameras/discover';

export function unavailableGo2rtcStreams(streams) {
  if (!streams || typeof streams !== 'object' || Array.isArray(streams)) {
    throw new Error('go2rtc streams response must be an object');
  }

  return Object.entries(streams)
    .filter(([, stream]) => !hasLiveProducer(stream))
    .map(([streamName]) => streamName)
    .sort();
}

export async function rediscoverUnavailableCameras(options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const streamsUrl = options.streamsUrl ?? DEFAULT_GO2RTC_STREAMS_URL;
  const discoveryUrl = options.discoveryUrl ?? DEFAULT_DISCOVERY_URL;
  const timeoutMs = positiveInteger(options.timeoutMs ?? 15_000, 'Camera rediscovery timeout');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const streamsResponse = await fetchImpl(streamsUrl, { signal: controller.signal });
    if (!streamsResponse.ok) {
      throw new Error(`go2rtc streams endpoint returned HTTP ${streamsResponse.status}`);
    }

    const unavailableStreamNames = unavailableGo2rtcStreams(await streamsResponse.json());
    if (unavailableStreamNames.length === 0) {
      return { attempted: false, unavailableStreamNames };
    }

    const discoveryResponse = await fetchImpl(discoveryUrl, {
      method: 'POST',
      signal: controller.signal
    });
    if (!discoveryResponse.ok) {
      throw new Error(`Camera discovery endpoint returned HTTP ${discoveryResponse.status}`);
    }
    await discoveryResponse.arrayBuffer();

    return { attempted: true, unavailableStreamNames };
  } finally {
    clearTimeout(timeout);
  }
}

function hasLiveProducer(stream) {
  const producers = Array.isArray(stream?.producers) ? stream.producers : [];
  return producers.some((producer) =>
    typeof producer?.remote_addr === 'string' && producer.remote_addr.length > 0
  );
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return parsed;
}
