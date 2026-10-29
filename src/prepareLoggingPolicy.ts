import { isSensitiveDiagnosticField } from './normalization/isSensitiveDiagnosticField';
import type { LoggingPolicy } from './types';

export function prepareLoggingPolicy(policy: LoggingPolicy): LoggingPolicy {
  const validName = (value: unknown): value is string =>
    typeof value === 'string' && /^[a-zA-Z][a-zA-Z0-9_.:-]{0,127}$/.test(value);
  if (
    !policy ||
    !validName(policy.service) ||
    !Array.isArray(policy.allowedFields) ||
    !Array.isArray(policy.startupScopes) ||
    !policy.allowedFields.every(
      (name) =>
        validName(name) &&
        !['constructor', 'prototype'].includes(name) &&
        !isSensitiveDiagnosticField(name),
    ) ||
    !policy.startupScopes.every(validName)
  ) {
    throw new TypeError('Invalid logging policy');
  }
  return Object.freeze({
    service: policy.service,
    allowedFields: Object.freeze([...policy.allowedFields]),
    startupScopes: Object.freeze([...policy.startupScopes]),
  });
}
