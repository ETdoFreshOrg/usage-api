// Runtime catalog metadata. Studio's Antigravity records have no producer feeding this API.
// Keep this outside proxy analytics and account snapshots so it never contributes to totals.
export const nativeUsage = {
  antigravity: {
    display_name: "Google Gemini",
    model_name: "Gemini 4 Neon",
    model_id: "gemini-4-neon-high",
    telemetry: "unavailable",
  },
} as const;
