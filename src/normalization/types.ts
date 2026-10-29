import type { LogSource } from '../types';

export interface NormalizationState {
  truncated: boolean;
  errorSource?: LogSource;
}

export interface DiagnosticTextPattern {
  expression: RegExp;
  runCharacter: RegExp;
  delimiters: string;
  startsAt(text: string, index: number): boolean;
  replacement?(match: RegExpExecArray): string;
}
