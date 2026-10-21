import { pino } from 'pino';

// Secrets must never reach the logs (spec 19). Redact by key name wherever they appear.
const REDACT_KEYS = [
  'apiKey',
  'api_key',
  'token',
  'password',
  'pass',
  'authorization',
  'ANTHROPIC_API_KEY',
  'TELEGRAM_BOT_TOKEN',
  'COMPANIES_HOUSE_API_KEY',
  'ADZUNA_APP_KEY',
  'PAGESPEED_API_KEY',
  'SEARCH_API_KEY',
  'SMTP_PASS',
  'IMAP_PASS',
];

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: {
    paths: REDACT_KEYS.flatMap((k) => [k, `*.${k}`, `*.*.${k}`]),
    censor: '[redacted]',
  },
});

export type Logger = typeof logger;
