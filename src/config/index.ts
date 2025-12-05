import dotenv from "dotenv";
dotenv.config();

export type HyperliquidEnvironment = "main" | "testnet";

export interface RiskConfig {
  minPositionUsd: number;
  copyRatio: number;
  maxLeverage: number;
  maxNotionalUsd: number;
  inverse: boolean;
  maxSlippageBps: number;
}

export interface CopyTradingConfig {
  environment: HyperliquidEnvironment;
  leaderAddress: `0x${string}`;
  followerPrivateKey: `0x${string}`;
  // ALWAYS present, but may be undefined if you want to use the follower account address
  followerVaultAddress: `0x${string}` | undefined;
  syncIntervalMs: number;
  reconciliationIntervalMs: number;
  refreshAccountIntervalMs: number;
  websocketAggregateFills: boolean;
  risk: RiskConfig;
}

/**
 * Normalize any env string to "main" or "testnet".
 * Never throws on unknown values – defaults to "main".
 */
function normalizeEnvironment(raw: string | undefined): HyperliquidEnvironment {
  if (!raw) return "main";

  const v = raw.toLowerCase().trim();
  if (v === "testnet") return "testnet";

  // Treat anything else as mainnet (production)
  return "main";
}

export function loadConfig(): CopyTradingConfig {
  const environment = normalizeEnvironment(process.env.HYPERLIQUID_ENVIRONMENT);

  const leaderAddress = process.env.LEADER_ADDRESS as `0x${string}`;
  const followerPrivateKey = process.env.FOLLOWER_PRIVATE_KEY as `0x${string}`;
  const followerVaultAddress = process.env.FOLLOWER_VAULT_ADDRESS as
    | `0x${string}`
    | undefined;

  if (!leaderAddress) {
    throw new Error("LEADER_ADDRESS is required");
  }
  if (!followerPrivateKey) {
    throw new Error("FOLLOWER_PRIVATE_KEY is required");
  }

  // ==== Risk config ====
  const minPositionUsd = Number(process.env.MIN_POSITION_USD ?? "40"); // raise to 40 to avoid micro-orders
  const copyRatio = Number(process.env.COPY_RATIO ?? "1");
  const maxLeverage = Number(process.env.MAX_LEVERAGE ?? "25");
  const maxNotionalUsd = Number(process.env.MAX_NOTIONAL_USD ?? "1000000");
  const inverse = (process.env.INVERSE_COPY ?? "false") === "true";
  const maxSlippageBps = Number(
    process.env.MAX_SLIPPAGE_BPS ??
      process.env.SLIPPAGE_BPS ??
      "50"
  );

  const risk: RiskConfig = {
    minPositionUsd,
    copyRatio,
    maxLeverage,
    maxNotionalUsd,
    inverse,
    maxSlippageBps,
  };

  // ==== Timings / misc ====
  const syncIntervalMs = Number(process.env.SYNC_INTERVAL_MS ?? "60000");
  const reconciliationIntervalMs = Number(
    process.env.RECONCILIATION_INTERVAL_MS ?? String(syncIntervalMs)
  );
  const refreshAccountIntervalMs = Number(
    process.env.REFRESH_ACCOUNT_INTERVAL_MS ?? "300000"
  );
  const websocketAggregateFills =
    (process.env.WEBSOCKET_AGGREGATE_FILLS ?? "true") === "true";

  const config: CopyTradingConfig = {
    environment,
    leaderAddress,
    followerPrivateKey,
    followerVaultAddress,
    syncIntervalMs,
    reconciliationIntervalMs,
    refreshAccountIntervalMs,
    websocketAggregateFills,
    risk,
  };

  // Safety logs – you'll see these on Render startup.
  console.log("[CONFIG] Environment:", environment);
  console.log("[CONFIG] Leader:", leaderAddress);
  console.log("[CONFIG] Vault:", followerVaultAddress);
  console.log("[CONFIG] Risk:", risk);

  return config;
}
