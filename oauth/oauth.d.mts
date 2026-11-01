// Types for the copied single-owner OAuth module (plain JS).
export const defaultGrantTtl: number;
export const claudeRedirects: string[];
export function defaultConsentPage(consent: Record<string, unknown>): (args: Record<string, unknown>) => string;
export function installOAuth(app: unknown, options: Record<string, unknown>): ((req: any, res: any, next: (err?: unknown) => void) => void) & {
  verifyAccessToken(token: string): Promise<unknown>;
  resource: string;
};
