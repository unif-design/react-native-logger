import type {
  LoggingHandle,
  LogMetadata,
  LogLevel,
  LogStatus,
  LogTrigger,
  OperationContext,
  LogSource,
  SerializedLogRecord,
} from '../types';

export interface LogRuntime extends LoggingHandle {
  emit(
    scope: string,
    level: LogLevel,
    event: string,
    metadata?: LogMetadata,
    source?: LogSource,
  ): string | null;
  context(trigger: LogTrigger, parent?: OperationContext): OperationContext;
  status(): LogStatus;
}

export interface LogDelivery {
  serialized: SerializedLogRecord;
  enqueued: boolean;
}
