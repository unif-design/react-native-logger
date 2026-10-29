import {
  CORRELATION_IDENTIFIER_PATTERN,
  NORMALIZATION_LIMITS,
  REDACTED_TEXT,
  TRUNCATED_TEXT,
} from './constants';
import type { NormalizationState } from './types';
import { redactDiagnosticText } from './redactDiagnosticText';
import { redactSensitiveText } from './redactSensitiveText';

export function redactLogText(
  text: string,
  state: NormalizationState,
  preserveCorrelation = false,
  maxCharacters: number = NORMALIZATION_LIMITS.stringCharacters,
): string {
  if (
    preserveCorrelation &&
    text.length > NORMALIZATION_LIMITS.correlationCharacters
  ) {
    state.truncated = true;
    return REDACTED_TEXT;
  }
  if (text.length > maxCharacters) {
    state.truncated = true;
    return TRUNCATED_TEXT;
  }

  const redacted = preserveCorrelation
    ? redactSensitiveText(text, true)
    : redactDiagnosticText(text);

  if (preserveCorrelation) {
    if (redacted === text && CORRELATION_IDENTIFIER_PATTERN.test(text)) {
      return text;
    }
    state.truncated = true;
    return REDACTED_TEXT;
  }
  if (redacted.length > maxCharacters) {
    state.truncated = true;
    return TRUNCATED_TEXT;
  }
  return redacted;
}
