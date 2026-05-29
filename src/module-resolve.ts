/**
 * Module-specifier resolution helpers — alias + extension probing that THREE
 * separate places used to do differently (with three different extension
 * lists, causing silent miss-rewrites). Canonical list + canonical probe
 * order live here.
 */
import * as path from 'node:path';
import type {ProjectInfo} from './preflight.js';

/**
 * Module extensions, in resolution priority. Mirrors what TS' bundler /
 * node resolvers try: `.tsx` before `.ts` before JS variants. `.mjs`/`.cjs`
 * are rarely seen in app code but cost nothing to probe.
 */
export const MODULE_EXTENSIONS: readonly string[] = ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.cjs'];

/**
 * Candidate absolute paths for a specifier that's been resolved to a
 * base path WITHOUT an extension. Returns:
 *   1. The base itself (in case it already had an extension)
 *   2. `base + <ext>` for each `MODULE_EXTENSIONS`
 *   3. `base/index<ext>` for each `MODULE_EXTENSIONS`
 *
 * If the base already carries a TS/JS extension, return it as-is — caller
 * shouldn't probe further.
 */
export function moduleCandidates(base: string): string[] {
    if (/\.(tsx?|jsx?|mjs|cjs)$/.test(base)) return [base];
    const out: string[] = [];
    for (const ext of MODULE_EXTENSIONS) out.push(base + ext);
    for (const ext of MODULE_EXTENSIONS) out.push(path.join(base, 'index' + ext));
    return out;
}

/**
 * Resolve a specifier (`./foo`, `@/bar/baz`) against the importer directory
 * AND the project's alias map to an ABSOLUTE base path without extension.
 * Returns null when the spec is a bare package (`react`, `zod`, …) — those
 * never travel with our refactors.
 */
export function resolveSpecifierBase(
    spec: string,
    importerDir: string,
    project: ProjectInfo,
): string | null {
    if (spec.startsWith('.')) return path.resolve(importerDir, spec);
    for (const {aliasPrefix, absPrefix} of project.aliasPrefixes) {
        if (spec === aliasPrefix.slice(0, -1) || spec.startsWith(aliasPrefix)) {
            return path.resolve(absPrefix, spec.slice(aliasPrefix.length));
        }
    }
    return null;
}

/**
 * Emit a relative import specifier from `fromDir` to `toAbs`. Always normalises
 * to forward slashes (Windows-safe) and prefixes `./` when the target is in the
 * same dir tree. Optionally strips TS/JS extensions so consumers can emit
 * extension-less specifiers (`./foo` instead of `./foo.tsx`) — that's the
 * style our import rewriter prefers.
 *
 * Four places used to hand-roll this with slightly different end-game (some
 * stripped extensions, some didn't). One helper, one rule.
 */
export function toRelativeImportSpec(
    fromDir: string,
    toAbs: string,
    options: {stripTsExt?: boolean} = {},
): string {
    let target = toAbs;
    if (options.stripTsExt) {
        target = target.replace(/\.(tsx?|jsx?)$/, '');
    }
    let rel = path.relative(fromDir, target).split(path.sep).join('/');
    if (!rel.startsWith('.')) rel = './' + rel;
    return rel;
}
