import { REDACTED_TEXT } from './constants';
import type { DiagnosticTextPattern } from './types';

export function redactDelimitedText(
  text: string,
  pattern: DiagnosticTextPattern,
): string {
  const anchored = new RegExp(
    pattern.expression.source,
    pattern.expression.flags.replace('g', '') + 'y',
  );
  const parts: string[] = [];
  let candidate = -1;
  let copiedUntil = 0;
  let index = 0;
  while (index < text.length) {
    if (pattern.runCharacter.test(text[index])) {
      if (candidate < 0 && pattern.startsAt(text, index)) candidate = index;
      index += 1;
      continue;
    }
    // 每段只在实际分隔符处尝试一次，避免正则从段内每个位置重扫长后缀。
    if (candidate >= 0 && pattern.delimiters.includes(text[index])) {
      anchored.lastIndex = candidate;
      const match = anchored.exec(text);
      if (match) {
        parts.push(
          text.slice(copiedUntil, candidate),
          pattern.replacement?.(match) ?? REDACTED_TEXT,
        );
        index = anchored.lastIndex;
        copiedUntil = index;
        candidate = -1;
        continue;
      }
    }
    candidate = -1;
    index += 1;
  }
  return parts.length ? parts.join('') + text.slice(copiedUntil) : text;
}
