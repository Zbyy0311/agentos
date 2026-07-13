export interface SseEvent {
  event: string;
  data: string;
}

export interface SseParseResult {
  events: SseEvent[];
  remainder: string;
}

export function parseSseEventData<T>(data: string): T | null {
  try {
    return JSON.parse(data) as T;
  } catch {
    return null;
  }
}

export function parseSseChunk(buffer: string, chunk: string): SseParseResult {
  const normalized = (buffer + chunk).replace(/\r\n/g, '\n');
  const rawEvents = normalized.split('\n\n');
  const remainder = rawEvents.pop() ?? '';
  const events: SseEvent[] = [];

  for (const rawEvent of rawEvents) {
    if (!rawEvent.trim()) continue;

    let event = 'message';
    const dataLines: string[] = [];

    for (const line of rawEvent.split('\n')) {
      if (!line || line.startsWith(':')) continue;
      if (line.startsWith('event:')) {
        event = line.slice(6).trim();
        continue;
      }
      if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart());
      }
    }

    if (dataLines.length === 0) continue;
    events.push({ event, data: dataLines.join('\n') });
  }

  return { events, remainder };
}
