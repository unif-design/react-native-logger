import {
  AUTH_SCHEME_PATTERN,
  DEVICE_LABEL_PATTERN,
  EMAIL_PATTERN,
  EMAIL_LOCAL_CHARACTER,
  FILE_URL_PATTERN,
  HEADER_SECRET_PATTERN,
  IMEI_PATTERN,
  ID_CARD_PATTERN,
  JWT_PATTERN,
  JWT_CHARACTER,
  JWT_PREFIX,
  MAC_PATTERN,
  PHONE_PATTERN,
  REDACTED_TEXT,
  RELATIVE_URL_PARAMETERS,
  RELATIVE_PATH_CHARACTER,
  SENSITIVE_ASSIGNMENT_PATTERN,
  URL_PATTERN,
  URL_SCHEME_CHARACTER,
  URL_START_CHARACTER,
  USER_PATH_PATTERN,
  UUID_PATTERN,
  WORD_CHARACTER,
} from './constants';
import { redactDelimitedText } from './redactDelimitedText';

function wordBoundaryAt(text: string, index: number): boolean {
  return (
    WORD_CHARACTER.test(text[index]) !==
    WORD_CHARACTER.test(index ? text[index - 1] : '')
  );
}

export function redactSensitiveText(
  text: string,
  preserveIdentifiers = false,
): string {
  let redacted =
    text.includes('/') || text.includes('\\')
      ? text.replace(USER_PATH_PATTERN, REDACTED_TEXT)
      : text;
  if (redacted.includes('://')) {
    redacted = redactDelimitedText(redacted, {
      expression: URL_PATTERN,
      runCharacter: URL_SCHEME_CHARACTER,
      delimiters: ':',
      startsAt: (value, index) =>
        URL_START_CHARACTER.test(value[index]) && wordBoundaryAt(value, index),
      replacement: ([url]) => {
        if (FILE_URL_PATTERN.test(url)) return REDACTED_TEXT;
        return url
          .replace(/(\/\/)[^/@]+@/, `$1${REDACTED_TEXT}@`)
          .replace(/[?#].*$/, REDACTED_TEXT);
      },
    });
  }
  if (redacted.includes('?') || redacted.includes('#')) {
    redacted = redactDelimitedText(redacted, {
      expression: RELATIVE_URL_PARAMETERS,
      runCharacter: RELATIVE_PATH_CHARACTER,
      delimiters: '?#',
      startsAt: (value, index) => value[index] === '/',
      replacement: (match) => `${match[1]}${REDACTED_TEXT}`,
    });
  }
  redacted = redacted
    .replace(HEADER_SECRET_PATTERN, `$1=${REDACTED_TEXT}`)
    .replace(AUTH_SCHEME_PATTERN, `$1 ${REDACTED_TEXT}`)
    .replace(SENSITIVE_ASSIGNMENT_PATTERN, `$1=${REDACTED_TEXT}`)
    .replace(DEVICE_LABEL_PATTERN, `$1 ${REDACTED_TEXT}`);
  if (redacted.includes('.')) {
    redacted = redactDelimitedText(redacted, {
      expression: JWT_PATTERN,
      runCharacter: JWT_CHARACTER,
      delimiters: '.',
      startsAt: (value, index) =>
        wordBoundaryAt(value, index) &&
        value.slice(index, index + JWT_PREFIX.length).toLowerCase() ===
          JWT_PREFIX.toLowerCase(),
    });
  }

  if (preserveIdentifiers) return redacted;
  redacted = redacted
    .replace(PHONE_PATTERN, REDACTED_TEXT)
    .replace(MAC_PATTERN, REDACTED_TEXT)
    .replace(UUID_PATTERN, REDACTED_TEXT)
    .replace(ID_CARD_PATTERN, REDACTED_TEXT)
    .replace(IMEI_PATTERN, REDACTED_TEXT);
  return redacted.includes('@')
    ? redactDelimitedText(redacted, {
        expression: EMAIL_PATTERN,
        runCharacter: EMAIL_LOCAL_CHARACTER,
        delimiters: '@',
        startsAt: wordBoundaryAt,
      })
    : redacted;
}
