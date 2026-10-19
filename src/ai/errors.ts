export type RetouchErrorCode = 'CONFIG' | 'INPUT' | 'NETWORK' | 'HTTP' | 'INVALID_RESPONSE' | 'NO_IMAGE' | 'CONTENT_FILTER';

export class RetouchError extends Error {
  readonly code: RetouchErrorCode;
  readonly status?: number;

  constructor(code: RetouchErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'RetouchError';
    this.code = code;
    this.status = status;
  }
}
