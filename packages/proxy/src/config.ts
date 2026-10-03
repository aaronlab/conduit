export interface Config {
  host: string;
  port: number;
  apiKey: string;
  internalKey: string;
  tokenPath: string;
  dbPath: string;
  logLevel: "debug" | "info" | "warn" | "error";
  baseUrl: string;
}

export function loadConfig(): Config {
  return {
    host: process.env.CONDUIT_HOST ?? "0.0.0.0",
    port: parseInt(process.env.CONDUIT_PORT ?? "7133", 10),
    apiKey: process.env.CONDUIT_API_KEY ?? "",
    internalKey: process.env.CONDUIT_INTERNAL_KEY ?? "",
    tokenPath: process.env.CONDUIT_TOKEN_PATH ?? "data/github_token",
    dbPath: process.env.CONDUIT_DB_PATH ?? "data/conduit.db",
    logLevel: (process.env.CONDUIT_LOG_LEVEL ?? "info") as Config["logLevel"],
    baseUrl: process.env.CONDUIT_BASE_URL ?? "",
  };
}
