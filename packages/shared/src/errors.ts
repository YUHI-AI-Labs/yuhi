/** Stable, user-facing error codes. Each maps to a documented remediation. */
export type YuhiErrorCode =
  | "CONFIG_NOT_FOUND"
  | "CONFIG_INVALID"
  | "NOT_A_DIRECTORY"
  | "AGENT_NOT_FOUND"
  | "AGENT_NOT_INSTALLED"
  | "WORKSPACE_NOT_FOUND"
  | "PATH_ESCAPE"
  | "INTERACTION_REQUIRED"
  | "UNSUPPORTED_PLATFORM"
  | "INTERNAL";

/**
 * All expected/handled failures throw a YuhiError. The CLI renders `.code`,
 * `.message`, and `.hint` (a concrete next step). Never put secret values in any
 * of these fields.
 */
export class YuhiError extends Error {
  readonly code: YuhiErrorCode;
  readonly hint?: string;
  readonly exitCode: number;

  constructor(
    code: YuhiErrorCode,
    message: string,
    opts?: { hint?: string; exitCode?: number; cause?: unknown },
  ) {
    super(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "YuhiError";
    this.code = code;
    this.hint = opts?.hint;
    this.exitCode = opts?.exitCode ?? 1;
  }
}

export function isYuhiError(e: unknown): e is YuhiError {
  return e instanceof YuhiError;
}
