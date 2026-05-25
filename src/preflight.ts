/**
 * Pre-flight: load tsconfig, parse aliases, normalize ops, validate.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import type {NormalizedOp, RefactorOp, RefactorOpInput} from './schema.js';
import {deriveVars, isTemplate, renderTemplate} from './template.js';

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
        if (!key.endsWith('/*')) continue;
        const aliasPrefix = key.slice(0, -1); // '@/*' → '@/'
        for (const v of vals) {
            if (!v.endsWith('/*')) continue;
            const target = v.slice(0, -1); // './src/*' → './src/'
            const absPrefix = path.resolve(baseUrl, target);
            aliasPrefixes.push({aliasPrefix, absPrefix});
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

/**
 * Decode an input op (tuple or full object) into the canonical RefactorOp shape.
 * Auto-detects a single `renameSymbols` entry when basenames change and the field
 * is omitted entirely (pass `renameSymbols: []` in the full form to suppress).
 */
function decode(input: RefactorOpInput, root: string): RefactorOp {
    let from: string;
    let to: string;
    let renameSymbols: Array<{old: string; new: string}> | undefined;

    if (Array.isArray(input)) {
        if (input.length !== 2 || typeof input[0] !== 'string' || typeof input[1] !== 'string') {
            throw new Error(`tuple op must be [from, to]: ${JSON.stringify(input)}`);
        }
        [from, to] = input;
        renameSymbols = undefined; // → autodetect below
    } else {
        from = input.from;
        to = input.to;
        renameSymbols = input.renameSymbols;
    }

    if (renameSymbols === undefined) {
        const detected = autodetectRename(from, to, root);
        renameSymbols = detected ? [detected] : [];
    }

    return {from, to, renameSymbols};
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
    const from = Array.isArray(input) ? input[0] : input.from;
    if (!from.includes('*')) return [input];

    const segments = from.split('/');
    const wildcardIdx = segments.findIndex((s) => s.includes('*'));
    if (wildcardIdx !== segments.length - 1) {
        throw new Error(`glob '*' must be in the final path segment: ${from}`);
    }
    const dirRel = segments.slice(0, -1).join('/');
    const pattern = segments[segments.length - 1];
    // Convert simple `*Name.tsx`-style patterns into a regex.
    const re = new RegExp(
        '^' +
            pattern
                .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
                .replace(/\*/g, '.*') +
            '$',
    );

    const dirAbs = path.resolve(root, dirRel);
    if (!fs.existsSync(dirAbs)) {
        throw new Error(`glob source dir not found: ${dirRel}`);
    }
    const entries = fs.readdirSync(dirAbs).filter((n) => re.test(n));
    if (entries.length === 0) {
        throw new Error(`glob matched zero entries: ${from}`);
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
    // Expand globs first, then decode.
    const expanded: RefactorOpInput[] = [];
    for (const raw of ops) {
        for (const exp of expandGlob(raw, root)) expanded.push(exp);
    }
    return expanded.map((raw, index) => {
        const decoded = decode(raw, root);
        const fromAbs = path.resolve(root, decoded.from);
        const toAbs = path.resolve(root, decoded.to);
        const ext = path.extname(decoded.from);
        const isFolder = ext === '';
        const sameParent = path.dirname(fromAbs) === path.dirname(toAbs);
        return {...decoded, index, fromAbs, toAbs, isFolder, sameParent};
    });
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

    for (const op of ops) {
        if (op.from === op.to) {
            errors.push({index: op.index, op, reason: 'from === to (no-op)'});
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
