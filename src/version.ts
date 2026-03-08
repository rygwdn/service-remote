'use strict';

import childProcess = require('child_process');

const { execSync } = childProcess;

// GIT_SHA may be injected at build time via an environment variable.
// If not set, we try to read it at runtime from git (dev mode).
function resolveGitSha(): string {
  const envSha = process.env.GIT_SHA;
  if (envSha) return envSha.slice(0, 7);
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return 'unknown';
  }
}

// Read version from package.json
const pkg = require('../package.json') as { version: string };

const gitSha = resolveGitSha();
const version = `${pkg.version}+${gitSha}`;

export = { version, gitSha };
