// Shared workspace error type. Kept separate so storage adapters can throw the
// same HTTP-mappable error without importing the file-operation module.
export class WorkspaceError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'WorkspaceError';
    this.status = status;
  }
}
