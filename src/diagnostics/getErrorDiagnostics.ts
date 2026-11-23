import type { DiagnosticError } from '../types';
import { normalizeLogError } from '../normalization/normalizeLogError';
import type { NormalizationState } from '../normalization/types';

/** 投影异常技术信息；不读取请求配置、响应正文或任意扩展属性，不改变原异常。 */
export function getErrorDiagnostics(error: unknown): DiagnosticError {
  const state: NormalizationState = { truncated: false };
  const result = normalizeLogError(error, state);
  if (state.truncated) result.truncated = true;
  if (state.errorSource) result.source = state.errorSource;
  return result;
}
