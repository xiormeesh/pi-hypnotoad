/** Persisted permission rules loaded from permissions.yml (or .json). */
export interface Permissions {
  allow: string[];
  deny: string[];
  ask: string[];
  /** Optional text injected into the system prompt to tell the model which commands are blocked. */
  systemPrompt?: string;
}

/** Session-scoped dev mode state (not persisted). */
export interface DevModeState {
  active: boolean;
  path: string;
}

/** Result of parsing a rule string like Bash(git push *) or Read(path:wiki/**). */
export interface ParsedRule {
  type: string;
  pattern: string;
}
