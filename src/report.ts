/**
 * Machine-readable run report. Written when `--report-json <path>` is passed.
 * Stable schema — CI gates and follow-up-ops generators depend on it.
 *
 * The shape is intentionally flat and discoverable: top-level groups
 * (`ops`, `applied`, `failed`, `warnings`, `prettier`, `cssReports`, `diff`,
 * `rollback`) line up with the human-readable report sections, so a user
 * skimming the JSON sees the same structure they saw in the terminal.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {Engine} from './engine.js';
import type {NormalizedExtractOp, NormalizedMoveOp, NormalizedOp} from './schema.js';
import {tsInfo} from './ts-loader.js';

export interface RunReport {
    /** front-renamer version (from package.json). */
    version: string;
    mode: 'dry' | 'apply';
    /** ISO timestamp when the run started. */
    startedAt: string;
    /** Total wall-clock time, milliseconds. */
    elapsedMs: number;
    /** Process exit code (0 = clean, 2 = post-typecheck or extract failures, …). */
    exitCode: number;

    project: {
        root: string;
        tsconfig: string;
        srcDir: string;
        ts: {version: string; from: 'project' | 'bundled'};
        prettier: {version: string; from: 'project'} | {available: false; reason: string};
    };

    ops: {
        input: number;
        applied: number;
        failed: number;
        byKind: {move: number; moveWithRename: number; extract: number};
    };

    /** Ops that completed successfully. Useful for sanity-diffing two runs. */
    applied: AppliedEntry[];

    /**
     * Ops that didn't apply. Each entry carries a stable `category` (or null
     * for unstructured throws) so consumers can group / gate / regenerate
     * a smaller ops.json for retry.
     */
    failed: FailedEntry[];

    /** Suspicious-but-not-fatal events (CSS sub-failures, etc.). */
    warnings: WarningEntry[];

    imports: {filesRewritten: number};

    prettier:
        | {available: true; version: string; formatted: number; skipped: number; failed: Array<{path: string; reason: string}>}
        | {available: false; reason: string};

    cssReports: Array<{
        sourceStylesheet: string;
        targetStylesheet: string | null;
        moved: string[];
        leftBehind: Array<{class: string; reason: string}>;
    }>;

    diff: {path: string} | null;

    rollback: {armed: boolean; sha: string | null};
}

interface AppliedMove {
    index: number;
    kind: 'move';
    from: string;
    to: string;
    renameSymbols: Array<{old: string; new: string}>;
}
interface AppliedExtract {
    index: number;
    kind: 'extract';
    symbol: string;
    from: string;
    to: string;
}
export type AppliedEntry = AppliedMove | AppliedExtract;

export interface FailedEntry {
    index: number;
    kind: 'move' | 'extract';
    /** Present for extract ops, the symbol the LS was asked to lift. */
    symbol?: string;
    from: string;
    to: string;
    /** Structured category for `ts-ls-*` failures; null for unstructured throws. */
    category: string | null;
    /** Extra triage info from the failure site, if any. */
    context: string | null;
    /** Original error message (use `category` for grep, this for context). */
    error: string;
    /** Deep link into the patterns doc when the category has one. */
    docs: string | null;
}

export interface WarningEntry {
    index: number;
    symbol: string;
    from: string;
    to: string;
    reason: string;
}

// ---------- builders ----------

export interface BuildReportInput {
    engine: Engine;
    mode: 'dry' | 'apply';
    startedAt: Date;
    elapsedMs: number;
    exitCode: number;
    version: string;
    diffPath: string | null;
    importsFilesRewritten: number;
    prettier:
        | {available: true; version: string; formatted: number; skipped: number; failed: Array<{path: string; reason: string}>}
        | {available: false; reason: string};
    rollback: {armed: boolean; sha: string | null};
    docsUrlFor: (category: string) => string | null;
}

export function buildRunReport(input: BuildReportInput): RunReport {
    const {engine} = input;
    const moves: NormalizedMoveOp[] = [];
    const movesWithRename: NormalizedMoveOp[] = [];
    const extracts: NormalizedExtractOp[] = [];
    for (const op of engine.appliedOps) {
        if (op.kind === 'extract') extracts.push(op);
        else if (op.renameSymbols.length > 0) movesWithRename.push(op);
        else moves.push(op);
    }

    const applied: AppliedEntry[] = engine.appliedOps.map(toAppliedEntry);
    const failed: FailedEntry[] = engine.opFailures.map((f) => {
        const op = f.op as NormalizedOp;
        const isExtract = op.kind === 'extract';
        return {
            index: f.index,
            kind: op.kind,
            symbol: isExtract ? op.extract : undefined,
            from: op.from,
            to: op.to,
            category: f.category,
            context: f.context,
            error: f.error,
            docs: f.category ? input.docsUrlFor(f.category) : null,
        };
    });
    const warnings: WarningEntry[] = engine.extractWarnings.map((w) => ({
        index: w.index,
        symbol: w.symbol,
        from: w.from,
        to: w.to,
        reason: w.reason,
    }));

    const ts = tsInfo();
    return {
        version: input.version,
        mode: input.mode,
        startedAt: input.startedAt.toISOString(),
        elapsedMs: Math.round(input.elapsedMs),
        exitCode: input.exitCode,
        project: {
            root: engine.project.root,
            tsconfig: engine.project.tsconfigPath,
            srcDir: engine.project.srcDir,
            ts,
            prettier: input.prettier.available
                ? {version: input.prettier.version, from: 'project'}
                : {available: false, reason: input.prettier.reason},
        },
        ops: {
            input: engine.appliedOps.length + engine.opFailures.length,
            applied: engine.appliedOps.length,
            failed: engine.opFailures.length,
            byKind: {
                move: moves.length,
                moveWithRename: movesWithRename.length,
                extract: extracts.length,
            },
        },
        applied,
        failed,
        warnings,
        imports: {filesRewritten: input.importsFilesRewritten},
        prettier: input.prettier,
        cssReports: engine.cssReports.map((r) => ({
            sourceStylesheet: r.sourceStylesheet,
            targetStylesheet: r.targetStylesheet ?? null,
            moved: [...r.moved],
            leftBehind: r.leftBehind.map((lb) => ({class: lb.class, reason: lb.reason})),
        })),
        diff: input.diffPath ? {path: input.diffPath} : null,
        rollback: input.rollback,
    };
}

function toAppliedEntry(op: NormalizedOp): AppliedEntry {
    if (op.kind === 'extract') {
        return {
            index: op.index,
            kind: 'extract',
            symbol: op.extract,
            from: op.from,
            to: op.to,
        };
    }
    return {
        index: op.index,
        kind: 'move',
        from: op.from,
        to: op.to,
        renameSymbols: op.renameSymbols.map((r) => ({old: r.old, new: r.new})),
    };
}

/** Atomic write — write to a sibling tempfile then rename, so a half-written file never leaks. */
export function writeRunReport(reportPath: string, report: RunReport): void {
    const abs = path.resolve(reportPath);
    fs.mkdirSync(path.dirname(abs), {recursive: true});
    const tmp = abs + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(report, null, 2) + '\n');
    fs.renameSync(tmp, abs);
}
