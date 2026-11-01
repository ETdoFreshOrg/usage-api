// Types for the copied OAuth store (plain JS, node:sqlite).
export class OAuthStore {
  constructor(path?: string);
  prune(now: number): void;
  close(): void;
}
