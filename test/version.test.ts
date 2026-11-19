import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PACKAGE_VERSION, USER_AGENT } from '../src/version.js';

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as Record<string, unknown>;
}

describe('version and package metadata', () => {
  const pkg = readJson('../package.json') as { name: string; version: string; mcpName: string };

  it('keeps the version constant in sync with package.json', () => {
    expect(PACKAGE_VERSION).toBe(pkg.version);
    expect(USER_AGENT).toBe(`${pkg.name}/${pkg.version}`);
  });

  it('keeps server.json in sync with package.json', () => {
    const server = readJson('../server.json') as {
      name: string;
      version: string;
      packages: Array<{ registryType: string; identifier: string; version: string }>;
    };
    expect(server.name).toBe(pkg.mcpName);
    expect(server.version).toBe(pkg.version);
    const npm = server.packages.find(p => p.registryType === 'npm');
    expect(npm?.identifier).toBe(pkg.name);
    expect(npm?.version).toBe(pkg.version);
  });
});
