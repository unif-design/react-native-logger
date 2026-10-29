import { redactSensitiveText } from './redactSensitiveText';

export function redactDiagnosticText(text: string): string {
  return redactSensitiveText(text);
}
