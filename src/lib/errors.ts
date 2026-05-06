export class LiquidityManagerError extends Error {
  readonly code: string;
  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions | undefined);
    this.code = code;
    this.name = "LiquidityManagerError";
  }
}

export class ConfigError extends LiquidityManagerError {
  constructor(message: string) {
    super("config_error", message);
    this.name = "ConfigError";
  }
}

export class UnauthorizedError extends LiquidityManagerError {
  constructor(message: string) {
    super("unauthorized", message);
    this.name = "UnauthorizedError";
  }
}

export class InsufficientBalanceError extends LiquidityManagerError {
  constructor(message: string) {
    super("insufficient_balance", message);
    this.name = "InsufficientBalanceError";
  }
}

export class NoPositionError extends LiquidityManagerError {
  constructor(message: string) {
    super("no_position", message);
    this.name = "NoPositionError";
  }
}

export class OnchainFailureError extends LiquidityManagerError {
  constructor(message: string, cause?: unknown) {
    super("onchain_failure", message, { cause });
    this.name = "OnchainFailureError";
  }
}

export class PriceFeedError extends LiquidityManagerError {
  constructor(message: string, cause?: unknown) {
    super("price_feed_error", message, { cause });
    this.name = "PriceFeedError";
  }
}
