/**
 * Resolve the project's prettier and run it on every file the batch touched.
 * Mirrors `ts-loader` in spirit — we DON'T bundle prettier; we either find it
 * in the target project's `node_modules` (and respect its config / version) or
 * skip formatting entirely. Bundling our own would mean a stale opinion
 * fighting the project's lint setup.
 *
 * The public API is minimal: `loadProjectPrettier(root)` returns either a
 * `{ available: false }` marker or a `formatFile(path, content)` function that
 * already knows about the project's `.prettierrc` / `.prettierignore`.
 */
import {createRequire} from 'node:module';
import * as path from 'node:path';

/**
 * Shape of the prettier module surface we actually use. Hand-rolled so we
 * don't pull in `@types/prettier` (and so a non-CJS/ESM mismatch doesn't
 * surprise us at runtime).
 */
interface PrettierAPI {
    version: string;
    format(source: string, options?: PrettierOptions): string | Promise<string>;
    resolveConfig(filePath: string): Promise<PrettierOptions | null>;
    getFileInfo(filePath: string, options?: {resolveConfig?: boolean}): Promise<{
        ignored: boolean;
        inferredParser: string | null;
    }>;
}

type PrettierOptions = Record<string, unknown> & {filepath?: string};

export interface LoadedPrettier {
    available: true;
    version: string;
    /**
     * Format the file's content using the project's resolved config. Returns
     * the formatted string, OR null when prettier decided to skip this file
     * (matched `.prettierignore`, or no parser inferred for the extension).
     */
    formatFile(absolutePath: string, content: string): Promise<string | null>;
}

export interface NoPrettier {
    available: false;
    /** Human-readable explanation for stage logs. */
    reason: string;
}

export async function loadProjectPrettier(projectRoot: string): Promise<LoadedPrettier | NoPrettier> {
    let prettier: PrettierAPI;
    try {
        const req = createRequire(path.join(projectRoot, 'package.json'));
        prettier = req('prettier') as PrettierAPI;
    } catch {
        return {available: false, reason: 'not installed in project'};
    }
    if (
        typeof prettier.format !== 'function' ||
        typeof prettier.resolveConfig !== 'function' ||
        typeof prettier.getFileInfo !== 'function'
    ) {
        return {available: false, reason: 'API mismatch — install a recent prettier'};
    }

    return {
        available: true,
        version: prettier.version,
        async formatFile(absolutePath, content) {
            const info = await prettier.getFileInfo(absolutePath, {resolveConfig: true});
            if (info.ignored) return null;
            if (!info.inferredParser) return null;
            const config = (await prettier.resolveConfig(absolutePath)) ?? {};
            // `filepath` is critical — prettier picks the parser AND any
            // per-file overrides from `.prettierrc` based on it. Without it
            // a `.tsx` file might be parsed as plain JS.
            const out = await prettier.format(content, {...config, filepath: absolutePath});
            return out;
        },
    };
}
