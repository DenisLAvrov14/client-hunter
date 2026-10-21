import 'dotenv/config';
import { ConfigError, loadConfig } from '../config/load.js';
import { loadEnv } from '../config/env.js';

try {
  const config = loadConfig();
  const env = loadEnv();
  const markets = [...config.markets.values()].map(
    (m) => `${m.code}: ${m.enabled ? 'enabled' : 'disabled'}, legal_review_done=${m.legal_review_done}`,
  );
  process.stdout.write(
    [
      'Config OK',
      ...markets.map((m) => `  ${m}`),
      `  segments: ${[...config.segments.keys()].join(', ')}`,
      `  SENDING_ENABLED=${env.SENDING_ENABLED} DRY_RUN=${env.DRY_RUN}`,
      '',
    ].join('\n'),
  );
} catch (err) {
  if (!(err instanceof ConfigError) && !(err instanceof Error && err.message.startsWith('Invalid environment'))) {
    throw err;
  }
  process.stderr.write(`${err.message}\n`);
  process.exitCode = 1;
}
