import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import type { z } from 'zod';
import {
  AppSchema,
  CapabilitiesSchema,
  CopyRulesSchema,
  IntentSchema,
  LimitsSchema,
  LlmSchema,
  MarketSchema,
  OffersSchema,
  ScoringSchema,
  SegmentSchema,
  type AppConfig,
  type CapabilitiesConfig,
  type CopyRulesConfig,
  type IntentConfig,
  type LimitsConfig,
  type LlmConfig,
  type MarketCode,
  type MarketConfig,
  type OffersConfig,
  type ScoringConfig,
  type SegmentCode,
  type SegmentConfig,
} from './schema.js';

export interface Config {
  app: AppConfig;
  limits: LimitsConfig;
  llm: LlmConfig;
  scoring: ScoringConfig;
  offers: OffersConfig;
  copyRules: CopyRulesConfig;
  intent: IntentConfig;
  capabilities: CapabilitiesConfig;
  markets: Map<MarketCode, MarketConfig>;
  segments: Map<SegmentCode, SegmentConfig>;
}

export class ConfigError extends Error {}

function loadFile<S extends z.ZodType>(file: string, schema: S): z.infer<S> {
  let raw: unknown;
  try {
    raw = parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new ConfigError(`${file}: cannot read/parse YAML: ${(err as Error).message}`);
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new ConfigError(`${file}: invalid config\n${issues.join('\n')}`);
  }
  return result.data;
}

function yamlFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yaml'))
    .sort()
    .map((f) => path.join(dir, f));
}

export function loadConfig(configDir = path.resolve('config')): Config {
  const markets = new Map<MarketCode, MarketConfig>();
  for (const file of yamlFiles(path.join(configDir, 'markets'))) {
    const market = loadFile(file, MarketSchema);
    if (markets.has(market.code)) throw new ConfigError(`${file}: duplicate market ${market.code}`);
    markets.set(market.code, market);
  }

  const segments = new Map<SegmentCode, SegmentConfig>();
  for (const file of yamlFiles(path.join(configDir, 'segments'))) {
    const segment = loadFile(file, SegmentSchema);
    if (segments.has(segment.code)) throw new ConfigError(`${file}: duplicate segment ${segment.code}`);
    segments.set(segment.code, segment);
  }

  return {
    app: loadFile(path.join(configDir, 'app.yaml'), AppSchema),
    limits: loadFile(path.join(configDir, 'limits.yaml'), LimitsSchema),
    llm: loadFile(path.join(configDir, 'llm.yaml'), LlmSchema),
    scoring: loadFile(path.join(configDir, 'scoring.yaml'), ScoringSchema),
    offers: loadFile(path.join(configDir, 'offers.yaml'), OffersSchema),
    copyRules: loadFile(path.join(configDir, 'copy-rules.yaml'), CopyRulesSchema),
    intent: loadFile(path.join(configDir, 'intent.yaml'), IntentSchema),
    capabilities: loadFile(path.join(configDir, 'capabilities.yaml'), CapabilitiesSchema),
    markets,
    segments,
  };
}
