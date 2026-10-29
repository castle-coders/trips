/**
 * Domain errors thrown by the service layer. REST maps them to HTTP status codes via the
 * shared onError hook in src/index.ts; MCP maps every code to an isError tool result.
 */
export type ServiceErrorCode = "not_found" | "forbidden" | "validation" | "conflict";

export const SERVICE_ERROR_STATUS: Record<ServiceErrorCode, 404 | 403 | 400 | 409> = {
  not_found: 404,
  forbidden: 403,
  validation: 400,
  conflict: 409,
};

export class ServiceError extends Error {
  constructor(
    public code: ServiceErrorCode,
    message: string,
    public details?: unknown
  ) {
    super(message);
    this.name = "ServiceError";
  }
}

/**
 * JSON body REST returns for a ServiceError: `{ error: message }`, plus `details` when set
 * (matches the existing itinerary validation response `{ error, details }`).
 */
export function serviceErrorBody(err: ServiceError): { error: string; details?: unknown } {
  return err.details === undefined ? { error: err.message } : { error: err.message, details: err.details };
}
