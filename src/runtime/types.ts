import type {
  LoggingHandle,
  LogMetadataInput,
  LogLevel,
  LogStatus,
  LogTrigger,
  OperationContext,
  SerializedLogRecord,
} from '../types';

export interface LogRuntime extends LoggingHandle {
  emit(
    scope: string,
    level: LogLevel,
    event: string,
    metadata?: LogMetadataInput,
    source?: Error,
    suppressConsole?: boolean,
  ): Promise<string | null>;
  context(trigger: LogTrigger, parent?: OperationContext): OperationContext;
  status(): LogStatus;
}

export interface LogDelivery {
  serialized: SerializedLogRecord;
  enqueued: boolean;
  startup: boolean;
  suppressConsole?: boolean;
}
