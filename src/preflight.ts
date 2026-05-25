/**
 * Pre-flight: load tsconfig, parse aliases, normalize ops, validate.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import type {NormalizedOp, RefactorOp, RefactorOpInput} from './schema.js';

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

export function normalizeOps(ops: RefactorOpInput[], root: string): NormalizedOp[] {
    return ops.map((raw, index) => {
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
