export type ErrorCode =
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "validation_error"
  | "invalid_transition"
  | "conflict"
  | "rate_limited"
  | "payload_rejected"
  | "internal_error";

const STATUS: Record<ErrorCode, number> = {
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  validation_error: 400,
  invalid_transition: 409,
  conflict: 409,
  rate_limited: 429,
  payload_rejected: 422,
  internal_error: 500,
};

/** Errors safe to show to clients. Messages must never contain personal data. */
export class AppError extends Error {
  constructor(public code: ErrorCode, message: string, public details?: unknown) {
    super(message);
  }
  get status() {
    return STATUS[this.code];
  }
}

export const notFound = (what = "대상") => new AppError("not_found", `${what}을(를) 찾을 수 없습니다.`);
export const forbidden = (message = "이 작업을 할 권한이 없습니다.") => new AppError("forbidden", message);
export const invalid = (message: string, details?: unknown) => new AppError("validation_error", message, details);
export const conflict = (message: string) => new AppError("conflict", message);
export const badTransition = (from: string, to: string) =>
  new AppError("invalid_transition", `현재 상태(${from})에서 ${to}(으)로 변경할 수 없습니다.`, { from, to });
