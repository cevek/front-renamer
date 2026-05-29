/**
 * Resolve the TypeScript runtime the TARGET project uses (its installed
 * `typescript` from node_modules) instead of the version this CLI bundles.
 * Lib.d.ts contents, module-resolution rules, stricter checks, and bug-fix
 * deltas all live in the project's TS — typechecking against ours would
 * produce false positives/negatives.
 *
 * Single export `ts` works in both positions:
 *   - Type position (`ts.Node`, `ts.SourceFile`, `ts.LanguageServiceHost`) —
 *     resolves through the bundled type declarations re-exported under the
 *     same name.
 *   - Value position (`ts.createProgram(...)`, `ts.SyntaxKind.X`) — every
 *     property access is intercepted and forwarded to the active runtime,
 *     which `initProjectTypescript` swaps to the project's instance at
 *     startup.
 *
 * `initProjectTypescript(projectRoot)` resolves `typescript` via `createRequire`
 * rooted at the project. The bundled `typescript` (declared as devDep) is
 * the fallback when no local install exists.
 */
import {createRequire} from 'node:module';
import * as path from 'node:path';

import bundledTs = require('typescript');

// Active runtime — swapped by `initProjectTypescript`. Type comes from the
// bundled package; project TS is duck-checked at load time.
let active: typeof bundledTs = bundledTs;
let initialised = false;
let resolvedFrom: 'project' | 'bundled' = 'bundled';
let resolvedVersion: string = bundledTs.version;

/**
 * Try to load `typescript` from the project. Idempotent — second call is a
 * no-op so a sub-component re-initialising can't surprise the cached state.
 */
export function initProjectTypescript(projectRoot: string): {from: 'project' | 'bundled'; version: string} {
    if (initialised) return {from: resolvedFrom, version: resolvedVersion};
    initialised = true;
    try {
        // Anchor the resolution at the project's package.json so node walks
        // ITS node_modules tree, not ours.
        const req = createRequire(path.join(projectRoot, 'package.json'));
        const projectTs = req('typescript') as typeof bundledTs;
        // Sanity-check the API surface we depend on. If a hand-rolled fork is
        // missing something critical, fall back rather than crash deep inside.
        if (
            typeof projectTs.createProgram === 'function' &&
            typeof projectTs.createLanguageService === 'function' &&
            typeof projectTs.createSourceFile === 'function'
        ) {
            active = projectTs;
            resolvedFrom = 'project';
            resolvedVersion = projectTs.version;
        }
    } catch {
        /* fallthrough — bundled stays active */
    }
    return {from: resolvedFrom, version: resolvedVersion};
}

/** Diagnostic — current TS metadata after `initProjectTypescript`. */
export function tsInfo(): {from: 'project' | 'bundled'; version: string} {
    return {from: resolvedFrom, version: resolvedVersion};
}

/**
 * Load `@cevek/typescript-extract-refactor-fix` — a patched TS that fixes the
 * `Expected symbol to be a module` assertion the stock LS throws on common
 * extract patterns (component-with-deep-alias-imports, row-from-table, etc).
 *
 * The patched module is a typescript drop-in (same default export shape), so
 * the caller can build a parallel `LanguageService` and reuse the host
 * factory unchanged. Returns the namespace directly, or null when the package
 * isn't installed (older installs / opt-out).
 *
 * Looked up here (front-renamer's own node_modules) — NOT in the project —
 * because the fix package is OUR dependency, not the user's.
 */
export function loadExtractFallbackTs(): typeof bundledTs | null {
    try {
        // Anchor on this module's location so we resolve our own dep, not the
        // user project's. `import.meta.url` is stable across CJS/ESM builds.
        const here = new URL('.', import.meta.url).pathname;
        const req = createRequire(path.join(here, 'package.json'));
        const fix = req('@cevek/typescript-extract-refactor-fix') as typeof bundledTs;
        if (typeof fix.createLanguageService !== 'function') return null;
        return fix;
    } catch {
        return null;
    }
}

// ---------- the `ts` export — value + type in one identifier ----------

// Re-export the bundled typescript namespace under name `ts`. This gives us
// `ts.Node`, `ts.SourceFile`, etc. as TYPES via the bundled .d.ts. The
// `import =` form is required because typescript uses `export =`.
export import ts = bundledTs;

// Now swap each VALUE the namespace exports to flow through the late-bound
// `active` runtime. After `initProjectTypescript`, every `ts.X` access reads
// from the project's typescript, not the bundled one. Types are unaffected —
// they're erased before this code runs.
//
// Safety: defineProperty on the module namespace OBJECT (the runtime value of
// `ts`). The proxy MUST go on properties that exist on bundledTs, so we
// enumerate `Object.keys(bundledTs)` rather than guess at member names.
const tsValue = ts as unknown as Record<PropertyKey, unknown>;
for (const key of Object.keys(bundledTs)) {
    const descriptor = Object.getOwnPropertyDescriptor(bundledTs, key);
    if (!descriptor || descriptor.configurable === false) continue;
    Object.defineProperty(tsValue, key, {
        configurable: true,
        enumerable: descriptor.enumerable,
        get() {
            return (active as unknown as Record<PropertyKey, unknown>)[key];
        },
    });
}
