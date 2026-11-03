/** An account action that failed, with the HTTP status and a short code for the UI. The message is safe to show. */
export class AccountError extends Error {
  constructor(status, code, message) {
    super(message ?? code);
    this.name = "AccountError";
    this.status = status;
    this.code = code;
  }
}
