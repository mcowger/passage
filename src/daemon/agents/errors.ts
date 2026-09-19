export class AgentError extends Error {
  constructor(readonly code: "not-found" | "archived" | "not-running" | "invalid-input" | "limit" | "draining", message: string) {
    super(message);
    this.name = "AgentError";
  }
}

export const ID = /^[A-Za-z0-9_-]{1,128}$/;
