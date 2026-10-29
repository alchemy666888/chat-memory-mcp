export type MemoryResultCode =
  | "DATABASE_UNAVAILABLE"
  | "DATABASE_TIMEOUT"
  | "SCHEMA_UNSUPPORTED"
  | "INVALID_STORED_STATE"
  | "INVALID_INPUT"
  | "INTERNAL";

export type TimeoutStage = "connect" | "query" | "lock" | "cancel" | null;

export class ConfigurationError extends Error {
  readonly field: string;

  constructor(field: string) {
    super("CONFIGURATION_UNAVAILABLE");
    this.name = "ConfigurationError";
    this.field = field;
  }
}

/** Client-visible message is the machine code only. */
export class MemoryReadError extends Error {
  readonly code: MemoryResultCode;
  readonly timeoutStage: TimeoutStage;

  constructor(code: MemoryResultCode, timeoutStage: TimeoutStage) {
    super(code);
    this.name = "MemoryReadError";
    this.code = code;
    this.timeoutStage = timeoutStage;
  }
}
