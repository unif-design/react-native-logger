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
  function descriptions(value: Readonly<Record<string, string>> | undefined) {
    if (value === undefined) return undefined;
    if (
      typeof value !== 'object' ||
      value === null ||
      !Object.entries(value).every(
        ([key, text]) =>
          validName(key) &&
          typeof text === 'string' &&
          text.length > 0 &&
          text.length <= 160,
      )
    ) {
      throw new TypeError('Invalid log descriptions');
    }
    return Object.freeze({ ...value });
  }
  return Object.freeze({
    service: policy.service,
    eventDescriptions: descriptions(policy.eventDescriptions),
    reasonDescriptions: descriptions(policy.reasonDescriptions),
    allowedFields: Object.freeze([...policy.allowedFields]),
    startupScopes: Object.freeze([...policy.startupScopes]),
  });
}
