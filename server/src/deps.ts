import type { Config } from './config';
import type { Database } from './db/client';
import { Hub } from './http/hub';
import { LoginThrottle, RateLimiter } from './http/rate-limit';
import { buildOriginPolicy } from './http/security';
import type { Deps } from './http/types';
import type { Logger } from './lib/log';

export function buildDeps(config: Config, db: Database, log: Logger): Deps {
  return {
    config,
    db,
    hub: new Hub(),
    limiter: new RateLimiter(config.rateLimitEnabled),
    loginThrottle: new LoginThrottle(config.rateLimitEnabled),
    log,
    origins: buildOriginPolicy(config.publicBaseUrl, config.allowedOrigins),
  };
}
