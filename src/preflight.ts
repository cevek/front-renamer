/**
 * Pre-flight: load tsconfig, parse aliases, normalize ops, validate.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import type {
    NormalizedExtractOp,
    NormalizedMoveOp,
    NormalizedOp,
    RefactorOp,
    RefactorOpExtract,
    RefactorOpInput,
} from './schema.js';
import {deriveVars, isTemplate, renderTemplate} from './template.js';

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
