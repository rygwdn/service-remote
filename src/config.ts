import fs = require('fs');
import path = require('path');
import type { Config } from './types';

const defaultConfig = require('../config.default.json') as Config;

let userConfig: Record<string, unknown> = {};
const userConfigPath = path.join(__dirname, '..', 'config.json');
if (fs.existsSync(userConfigPath)) {
  userConfig = JSON.parse(fs.readFileSync(userConfigPath, 'utf-8')) as Record<string, unknown>;
}

function merge<T extends Record<string, unknown>>(base: T, override: Record<string, unknown>): T {
  const result = { ...base } as T;
  for (const key of Object.keys(override) as Array<keyof T>) {
    const overrideVal = override[key as string];
    const baseVal = base[key];
    if (
      overrideVal !== null &&
      overrideVal !== undefined &&
      typeof overrideVal === 'object' &&
      !Array.isArray(overrideVal) &&
      baseVal !== null &&
      baseVal !== undefined &&
      typeof baseVal === 'object' &&
      !Array.isArray(baseVal)
    ) {
      result[key] = merge(baseVal as Record<string, unknown>, overrideVal as Record<string, unknown>) as T[keyof T];
    } else {
      result[key] = overrideVal as T[keyof T];
    }
  }
  return result;
}

const config: Config & { merge: typeof merge } = Object.assign(
  merge(defaultConfig as unknown as Record<string, unknown>, userConfig) as unknown as Config,
  { merge }
);
export = config;
