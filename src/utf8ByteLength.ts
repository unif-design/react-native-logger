import Utf8 from 'crypto-js/enc-utf8.js';
import { UTF16_SURROGATE_UNITS } from './normalization/constants';

export function utf8ByteLength(text: string): number {
  const validText = text.replace(UTF16_SURROGATE_UNITS, (unit) =>
    unit.length === 2 ? unit : '\ufffd',
  );
  return Utf8.parse(validText).sigBytes;
}
