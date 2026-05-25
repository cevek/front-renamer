#!/usr/bin/env node
/**
 * Build the package, pack it, and run a dry-run against the ops file referenced
 * by the FRONT_RENAMER_E2E_OPS env var (or `examples/ops-mixed-example.json`).
 *
 * Used as a smoke test before publishing. Set FRONT_RENAMER_E2E_TARGET to a
 * real project root to run against an actual repo.
 */
import {execSync} from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '..');

console.log('[e2e] building…');
execSync('npm run build', {cwd: pkgRoot, stdio: 'inherit'});

console.log('[e2e] packing…');
execSync('npm pack --silent', {cwd: pkgRoot, stdio: 'inherit'});
const pkgJson = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'));
const tarball = path.join(pkgRoot, `${pkgJson.name}-${pkgJson.version}.tgz`);
if (!fs.existsSync(tarball)) {
    console.error(`[e2e] expected tarball missing: ${tarball}`);
    process.exit(1);
}
console.log(`[e2e] packed: ${path.relative(process.cwd(), tarball)}`);

const target = process.env.FRONT_RENAMER_E2E_TARGET;
const opsFile = process.env.FRONT_RENAMER_E2E_OPS ?? path.join(pkgRoot, 'examples/ops-mixed-example.json');
if (!target) {
    console.log('[e2e] no FRONT_RENAMER_E2E_TARGET set — packing only. Done.');
    process.exit(0);
}
if (!fs.existsSync(target)) {
    console.error(`[e2e] target project not found: ${target}`);
    process.exit(1);
}

console.log(`[e2e] dry-run against ${target}`);
execSync(`node ${path.join(pkgRoot, 'dist/bin.js')} ${opsFile} --dry --cwd ${target}`, {
    stdio: 'inherit',
});
console.log('[e2e] ok.');
