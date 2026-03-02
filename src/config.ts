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

function reload(): void {
  let freshUserConfig: Record<string, unknown> = {};
  if (fs.existsSync(userConfigPath)) {
    freshUserConfig = JSON.parse(fs.readFileSync(userConfigPath, 'utf-8')) as Record<string, unknown>;
  }
  const merged = merge(defaultConfig as unknown as Record<string, unknown>, freshUserConfig) as unknown as Config;
  Object.assign(config.obs, merged.obs);
  Object.assign(config.x32, merged.x32);
  config.x32.channels = merged.x32.channels;
  Object.assign(config.proclaim, merged.proclaim);
}

const config: Config & { merge: typeof merge; reload: typeof reload } = Object.assign(
  merge(defaultConfig as unknown as Record<string, unknown>, userConfig) as unknown as Config,
  { merge, reload }
);
export = config;
