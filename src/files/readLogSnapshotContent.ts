import { utf8ByteLength } from '../utf8ByteLength';
import type { LogSnapshotContent } from './types';

export function readLogSnapshotContent(
  text: string,
  recordBytes: number,
): LogSnapshotContent {
  const lines = text.split('\n');
  let corruptedLines = lines.pop() ? 1 : 0;
  const valid: string[] = [];
  for (const line of lines) {
    try {
      const record: unknown = JSON.parse(line);
      if (
        !record ||
        typeof record !== 'object' ||
        Array.isArray(record) ||
        utf8ByteLength(`${line}\n`) > recordBytes
      ) {
        corruptedLines++;
      } else {
        valid.push(`${line}\n`);
      }
    } catch {
      corruptedLines++;
    }
  }
  return { text: valid.join(''), corruptedLines };
}
