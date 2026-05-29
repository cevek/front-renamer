/**
 * Pre-flight: load tsconfig, parse aliases, normalize ops, validate.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {ts} from './ts-loader.js';
import type {
    NormalizedExtractOp,
    NormalizedMoveOp,
    NormalizedOp,
    RefactorOp,
    RefactorOpExtract,
    RefactorOpInput,
} from './schema.js';
import {deriveExtractVars, deriveVars, isTemplate, renderTemplate} from './template.js';

function isExtractOp(input: RefactorOpInput): input is RefactorOpExtract {
    return !Array.isArray(input) && 'extract' in input && typeof (input as RefactorOpExtract).extract === 'string';
}

export interface ProjectInfo {
    root: string;
    tsconfigPath: string;
    compilerOptions: ts.CompilerOptions;
    /** Source directory that participates in the refactor (e.g. `<root>/src`). */
    srcDir: string;
    /** Map from absolute alias prefix on disk (e.g. `/abs/src`) → alias key prefix (e.g. `@/`). */
    aliasPrefixes: Array<{aliasPrefix: string; absPrefix: string}>;
    /** All .ts/.tsx files initially in the project (used as baseline for the language service). */
    sourceFiles: string[];
}

export interface LoadProjectOptions {
    /** Explicit tsconfig path. Defaults to autodetect: tsconfig.app.json → tsconfig.json. */
    tsconfigPath?: string;
    /** Source directory to scan. Defaults to `<root>/src`. */
    srcDir?: string;
}

function autodetectTsconfig(root: string): string {
    for (const candidate of ['tsconfig.app.json', 'tsconfig.json']) {
        const p = path.join(root, candidate);
        if (fs.existsSync(p)) return p;
    }
    throw new Error(`no tsconfig found at ${root} (looked for tsconfig.app.json, tsconfig.json)`);
}

export function loadProject(root: string, opts: LoadProjectOptions = {}): ProjectInfo {
    const tsconfigPath = opts.tsconfigPath
        ? path.resolve(root, opts.tsconfigPath)
        : autodetectTsconfig(root);

    const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
    if (configFile.error) {
        throw new Error(`Failed to read ${tsconfigPath}: ${configFile.error.messageText}`);
    }
    const parsed = ts.parseJsonConfigFileContent(
        configFile.config,
        ts.sys,
        path.dirname(tsconfigPath),
    );

    const aliasPrefixes: Array<{aliasPrefix: string; absPrefix: string}> = [];
    const paths = parsed.options.paths ?? {};
    const baseUrl = parsed.options.baseUrl ?? path.dirname(tsconfigPath);
    for (const [key, vals] of Object.entries(paths)) {
        // Glob form: `"@/*": ["./src/*"]` — both sides end with /*. Prefix match.
        if (key.endsWith('/*')) {
            const aliasPrefix = key.slice(0, -1); // '@/*' → '@/'
            for (const v of vals) {
                if (!v.endsWith('/*')) continue;
                const target = v.slice(0, -1); // './src/*' → './src/'
                const absPrefix = path.resolve(baseUrl, target);
                aliasPrefixes.push({aliasPrefix, absPrefix});
            }
            continue;
        }
        // Bare form: `"@types": ["./types"]` — single specifier → single file/dir.
        // Represent as a prefix where both sides include a trailing slash so
        // ONLY the exact key matches via `===` paths in the rewriter.
        for (const v of vals) {
            if (v.endsWith('/*')) continue;
            aliasPrefixes.push({aliasPrefix: key, absPrefix: path.resolve(baseUrl, v)});
        }
    }

    const srcDir = opts.srcDir ? path.resolve(root, opts.srcDir) : path.join(root, 'src');
    if (!fs.existsSync(srcDir)) {
        throw new Error(`source directory not found: ${srcDir}`);
    }
    const sourceFiles = collectSourceFiles(srcDir);

    return {
        root,
        tsconfigPath,
        compilerOptions: parsed.options,
        srcDir,
        aliasPrefixes,
        sourceFiles,
    };
}

function collectSourceFiles(dir: string): string[] {
    const out: string[] = [];
    const walk = (d: string) => {
        for (const entry of fs.readdirSync(d, {withFileTypes: true})) {
            const p = path.join(d, entry.name);
            if (entry.isDirectory()) walk(p);
            else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(p);
        }
    };
    walk(dir);
    return out;
}

/** Decode an input op into the canonical discriminated-union RefactorOp shape. */
function decode(input: RefactorOpInput, root: string): RefactorOp {
    if (isExtractOp(input)) {
        return {
            kind: 'extract',
            extract: input.extract,
            from: input.from,
            to: input.to,
            css: input.css ?? 'none',
        };
    }

    let from: string;
    let to: string;
    let renameSymbols: Array<{old: string; new: string}> | undefined;

    if (Array.isArray(input)) {
        if (input.length !== 2 || typeof input[0] !== 'string' || typeof input[1] !== 'string') {
            throw new Error(`tuple op must be [from, to]: ${JSON.stringify(input)}`);
        }
        [from, to] = input;
        renameSymbols = undefined;
    } else {
        from = input.from;
        to = input.to;
        renameSymbols = input.renameSymbols;
    }

    if (renameSymbols === undefined) {
        const detected = autodetectRename(from, to, root);
        renameSymbols = detected ? [detected] : [];
    }

    return {kind: 'move', from, to, renameSymbols};
}

function autodetectRename(from: string, to: string, root: string): {old: string; new: string} | null {
    const fromBase = path.basename(from);
    const toBase = path.basename(to);
    const fromExt = path.extname(from);
    const toExt = path.extname(to);

    if (fromExt) {
        if (fromExt !== toExt) return null;
        const oldName = path.basename(from, fromExt);
        const newName = path.basename(to, toExt);
        if (oldName === newName) return null;
        return {old: oldName, new: newName};
    }

    if (fromBase === toBase) return null;
    for (const ext of ['.tsx', '.ts']) {
        const mainFile = path.join(root, from, fromBase + ext);
        if (fs.existsSync(mainFile)) return {old: fromBase, new: toBase};
    }
    return null;
}

/**
 * Expand glob-source ops into one op per matched child.
 *
 *   ["src/components/ds/*", "src/components/"]
 *   → ["src/components/ds/A", "src/components/A"]
 *     ["src/components/ds/B", "src/components/B"]
 *     ...
 *
 * The `*` must be in the FINAL segment of `from` (one-level wildcard). `to`
 * is treated as the destination DIRECTORY — each matched child keeps its name.
 */
function expandGlob(input: RefactorOpInput, root: string): RefactorOpInput[] {
    if (isExtractOp(input)) return [input]; // extract ops don't use glob
    const from = Array.isArray(input) ? input[0] : input.from;
    if (!from.includes('*') && !from.includes('?')) return [input];

    const segments = from.split('/');
    const wildcardIdx = segments.findIndex((s) => /[*?]/.test(s));
    if (wildcardIdx !== segments.length - 1) {
        throw new Error(`glob wildcard must be in the final path segment: ${from}`);
    }
    const dirRel = segments.slice(0, -1).join('/');
    const pattern = segments[segments.length - 1];
    // Patterns: `*` (any chars except '/'), `?` (one char). Other regex
    // metacharacters are escaped so users can mix literal punctuation.
    let reSrc = '';
    for (const ch of pattern) {
        if (ch === '*') reSrc += '[^/]*';
        else if (ch === '?') reSrc += '[^/]';
        else if ('.+^${}()|[]\\'.includes(ch)) reSrc += '\\' + ch;
        else reSrc += ch;
    }
    const re = new RegExp('^' + reSrc + '$');

    const dirAbs = path.resolve(root, dirRel);
    if (!fs.existsSync(dirAbs)) {
        throw new Error(`glob source dir not found: ${dirRel}`);
    }
    const entries = fs.readdirSync(dirAbs).filter((n) => re.test(n));
    if (entries.length === 0) {
        // Throw a TAGGED error that bin.ts/normalizeOps catches and converts to a
        // friendly validation message instead of a fatal stack trace.
        const err = new Error(`glob matched zero entries: ${from}`) as Error & {kind?: string};
        err.kind = 'validation';
        throw err;
    }

    const to = Array.isArray(input) ? input[1] : input.to;
    const renameSymbols = Array.isArray(input) ? undefined : input.renameSymbols;
    const templated = isTemplate(to);
    const toDir = !templated && to.endsWith('/') ? to.slice(0, -1) : to;

    return entries.map((name) => {
        const childFrom = `${dirRel}/${name}`;
        let childTo: string;
        if (templated) {
            const vars = deriveVars(childFrom);
            childTo = renderTemplate(to, vars);
        } else {
            childTo = `${toDir}/${name}`;
        }
        if (renameSymbols !== undefined) {
            return {from: childFrom, to: childTo, renameSymbols};
        }
        return [childFrom, childTo];
    });
}

/**
 * Render extract-op `to` templates in-place. Two trigger conditions:
 *   - op has `extract` + `from` but no `to`, AND a CLI default pattern is
 *     provided → render the default.
 *   - op's own `to` contains `{…}` → render it directly.
 *
 * Returns the list of render errors. Doesn't throw — caller merges with
 * schema-validation errors so the user sees ALL problems at once instead
 * of fixing one, re-running, finding the next.
 */
export function expandExtractTemplates(
    opsArray: unknown,
    extractToPattern: string | undefined,
): RawValidationError[] {
    const errors: RawValidationError[] = [];
    if (!Array.isArray(opsArray)) return errors;
    opsArray.forEach((raw, index) => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
        const obj = raw as Record<string, unknown>;
        if (typeof obj.extract !== 'string' || typeof obj.from !== 'string') return;
        const vars = deriveExtractVars(obj.from, obj.extract);

        const toMissing = !('to' in obj) || obj.to === undefined || obj.to === '';
        if (toMissing && extractToPattern) {
            try {
                obj.to = renderTemplate(extractToPattern, vars);
            } catch (err) {
                errors.push({
                    index,
                    reason: `--extract-to template failed: ${(err as Error).message}`,
                });
            }
            return;
        }
        if (typeof obj.to === 'string' && isTemplate(obj.to)) {
            try {
                obj.to = renderTemplate(obj.to, vars);
            } catch (err) {
                errors.push({
                    index,
                    reason: `"to" template failed: ${(err as Error).message}`,
                });
            }
        }
    });
    return errors;
}

/**
 * Schema-validate raw ops BEFORE normalization — catches typos in field names,
 * wrong types, missing required fields, and `from` paths that don't exist on
 * disk. Returns one error per problem with the offending op's index so users
 * see the full set in one go instead of fixing-rerunning.
 *
 * Designed to be the FIRST thing the CLI runs after JSON.parse, so a slip like
 * `"from1"` doesn't crash deep inside path.resolve with `paths[1] is undefined`.
 */
export function validateRawOps(ops: unknown, root: string): RawValidationError[] {
    const errors: RawValidationError[] = [];

    if (!Array.isArray(ops)) {
        errors.push({index: -1, reason: 'ops must be an array (or {ops: [...]})'});
        return errors;
    }

    ops.forEach((raw, index) => {
        if (Array.isArray(raw)) {
            // Short-tuple form: [from, to].
            if (raw.length !== 2) {
                errors.push({index, reason: `tuple op must have exactly 2 elements [from, to], got ${raw.length}`});
                return;
            }
            if (typeof raw[0] !== 'string' || typeof raw[1] !== 'string') {
                errors.push({index, reason: 'tuple op elements must both be strings'});
                return;
            }
            checkFromExists(index, raw[0], root, errors);
            return;
        }

        if (raw === null || typeof raw !== 'object') {
            errors.push({index, reason: `op must be an object or a [from, to] tuple, got ${typeof raw}`});
            return;
        }

        const obj = raw as Record<string, unknown>;
        const isExtract = 'extract' in obj;

        // Required strings.
        for (const field of isExtract ? ['extract', 'from', 'to'] : ['from', 'to']) {
            if (!(field in obj)) {
                errors.push({index, reason: `missing required field "${field}"`});
            } else if (typeof obj[field] !== 'string' || (obj[field] as string).length === 0) {
                errors.push({index, reason: `field "${field}" must be a non-empty string, got ${describeType(obj[field])}`});
            }
        }

        // Unknown-field detection — fail loud on typos like `from1`. Suggest
        // the closest legitimate field name when one is plausibly meant.
        const allowed = isExtract
            ? new Set(['extract', 'from', 'to', 'css'])
            : new Set(['from', 'to', 'renameSymbols']);
        for (const key of Object.keys(obj)) {
            if (allowed.has(key)) continue;
            const suggestion = closestKey(key, allowed);
            const hint = suggestion ? ` — did you mean "${suggestion}"?` : '';
            errors.push({index, reason: `unknown field "${key}" for ${isExtract ? 'extract' : 'move'} op${hint}`});
        }

        // Optional fields, when present, must be the right shape.
        if (isExtract && 'css' in obj) {
            const css = obj.css;
            if (css !== undefined && css !== 'none' && css !== 'copy-safe' && css !== 'empty-stub') {
                errors.push({
                    index,
                    reason: `"css" must be one of "none" | "copy-safe" | "empty-stub", got ${JSON.stringify(css)}`,
                });
            }
        }
        if (!isExtract && 'renameSymbols' in obj) {
            const rs = obj.renameSymbols;
            if (!Array.isArray(rs)) {
                errors.push({index, reason: '"renameSymbols" must be an array'});
            } else {
                rs.forEach((entry, i) => {
                    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
                        errors.push({index, reason: `renameSymbols[${i}] must be an object {old, new}`});
                        return;
                    }
                    const e = entry as Record<string, unknown>;
                    if (typeof e.old !== 'string' || typeof e.new !== 'string') {
                        errors.push({index, reason: `renameSymbols[${i}] must be {old: string, new: string}`});
                    }
                });
            }
        }

        // Existence check on `from` — only when it's a usable string AND not a
        // glob (globs are resolved later in `expandGlob`).
        if (typeof obj.from === 'string' && obj.from.length > 0) {
            const from = obj.from;
            if (!from.includes('*') && !from.includes('?')) {
                checkFromExists(index, from, root, errors);
            }
        }
    });

    return errors;
}

function checkFromExists(index: number, from: string, root: string, errors: RawValidationError[]): void {
    const abs = path.resolve(root, from);
    if (fs.existsSync(abs)) return;
    errors.push({index, reason: `"from" path does not exist: ${from}`});
}

function describeType(v: unknown): string {
    if (v === null) return 'null';
    if (Array.isArray(v)) return 'array';
    return typeof v;
}

/**
 * Levenshtein distance ≤ 2 → suggest the candidate. Cheap and good enough for
 * single-typo detection (`from1` → `from`, `t0` → `to`, `extact` → `extract`).
 */
function closestKey(key: string, candidates: Set<string>): string | null {
    let best: {key: string; dist: number} | null = null;
    for (const c of candidates) {
        const d = levenshtein(key, c);
        if (d <= 2 && (!best || d < best.dist)) best = {key: c, dist: d};
    }
    return best ? best.key : null;
}

function levenshtein(a: string, b: string): number {
    if (a === b) return 0;
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;
    const prev = new Array<number>(b.length + 1);
    const curr = new Array<number>(b.length + 1);
    for (let j = 0; j <= b.length; j++) prev[j] = j;
    for (let i = 1; i <= a.length; i++) {
        curr[0] = i;
        for (let j = 1; j <= b.length; j++) {
            const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
            curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
        }
        for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
    }
    return prev[b.length];
}

export interface RawValidationError {
    /** Index in the raw ops array; -1 means the array itself is malformed. */
    index: number;
    reason: string;
}

export function normalizeOps(ops: RefactorOpInput[], root: string): NormalizedOp[] {
    const expanded: RefactorOpInput[] = [];
    for (const raw of ops) {
        try {
            for (const exp of expandGlob(raw, root)) expanded.push(exp);
        } catch (err) {
            const e = err as Error & {kind?: string};
            if (e.kind === 'validation') {
                // Re-throw a marked Error so bin.ts presents it cleanly.
                throw new GlobValidationError(e.message);
            }
            throw err;
        }
    }
    return expanded.map((raw, index): NormalizedOp => {
        const decoded = decode(raw, root);
        const fromAbs = path.resolve(root, decoded.from);
        const toAbs = path.resolve(root, decoded.to);
        if (decoded.kind === 'extract') {
            const out: NormalizedExtractOp = {
                ...decoded,
                index,
                fromAbs,
                toAbs,
                isFolder: false,
            };
            return out;
        }
        const ext = path.extname(decoded.from);
        const isFolder = ext === '';
        const sameParent = path.dirname(fromAbs) === path.dirname(toAbs);
        const out: NormalizedMoveOp = {
            ...decoded,
            index,
            fromAbs,
            toAbs,
            isFolder,
            sameParent,
        };
        return out;
    });
}

export class GlobValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'GlobValidationError';
    }
}

export interface ValidationError {
    index: number;
    op: {from: string; to: string};
    reason: string;
}

export function validateOps(ops: NormalizedOp[]): ValidationError[] {
    const errors: ValidationError[] = [];
    const seenFrom = new Map<string, number>();
    const seenTo = new Map<string, number>();

    // Extract ops legitimately repeat `from` (many extracts from one source) and
    // `to` (many symbols collected into one target). Duplicate-checking applies
    // only to move ops. For extracts we require (from, to, symbol) to be unique.
    const seenExtract = new Map<string, number>();
    for (const op of ops) {
        if (op.from === op.to) {
            errors.push({index: op.index, op, reason: 'from === to (no-op)'});
        }
        if (op.kind === 'extract') {
            const key = `${op.fromAbs}|${op.toAbs}|${op.extract}`;
            const prev = seenExtract.get(key);
            if (prev !== undefined) {
                errors.push({
                    index: op.index,
                    op,
                    reason: `duplicate extract — same symbol "${op.extract}" from "${op.from}" to "${op.to}" already at op #${prev}`,
                });
            }
            seenExtract.set(key, op.index);
            continue;
        }
        const prevFrom = seenFrom.get(op.fromAbs);
        if (prevFrom !== undefined) {
            errors.push({index: op.index, op, reason: `duplicate from (also at op #${prevFrom})`});
        }
        seenFrom.set(op.fromAbs, op.index);

        const prevTo = seenTo.get(op.toAbs);
        if (prevTo !== undefined) {
            errors.push({index: op.index, op, reason: `duplicate to (also at op #${prevTo})`});
        }
        seenTo.set(op.toAbs, op.index);
    }
    return errors;
}
