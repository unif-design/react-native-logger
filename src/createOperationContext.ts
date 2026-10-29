import { readLogRuntime } from './state';
import type { LogTrigger, OperationContext } from './types';

export function createOperationContext(
  trigger: LogTrigger,
  parent?: OperationContext,
): OperationContext {
  try {
    const context = readLogRuntime()?.context(trigger, parent);
    if (context) return context;
  } catch {
    // 日志自身失败时沿用不可记录的上下文，不改变业务控制流。
  }
  return Object.freeze({
    runId: 'uninstalled',
    operationId: 'uninstalled',
    identityEpoch: 'uninstalled',
    trigger,
    startedAt: 0,
  });
}
