import { SENSITIVE_DIAGNOSTIC_FIELD_PATTERN } from './constants';

export function isSensitiveDiagnosticField(name: string): boolean {
  return SENSITIVE_DIAGNOSTIC_FIELD_PATTERN.test(name);
}
