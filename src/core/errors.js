/** Error type for data that does not conform to the workspace schema. */
export class WorkspaceFormatError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "WorkspaceFormatError";
  }
}

/** Error type for a command that fails validation before any mutation. */
export class CommandError extends Error {
  /**
   * @param {string} message
   * @param {string} [reason] Machine-readable reason, e.g. "unknownType".
   */
  constructor(message, reason = "invalid") {
    super(message);
    this.name = "CommandError";
    this.reason = reason;
  }
}
