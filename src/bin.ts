#!/usr/bin/env node
/**
 * front-renamer CLI.
 *
 *   front-renamer <ops.json> [options]
 *
 * Options:
 *   --apply              Commit changes to disk (default is dry-run).
 *   --dry                Force dry-run mode (default).
 *   --cwd <path>         Project root. Default: current working directory.
 *   --tsconfig <path>    tsconfig file. Default: autodetect tsconfig.app.json → tsconfig.json.
 *   --src <path>         Source directory to scan. Default: <root>/src.
 *   --skip-typecheck     Skip pre-/post-typecheck (faster, less safe).
 *   --quiet              Reduce output to errors and final status.
 *   -h, --help           Show this help.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {OpsInput, RefactorOpInput} from './schema.js';
import {loadProject, normalizeOps, validateOps} from './preflight.js';
import {buildPlan, summarizePlan} from './plan.js';
import {Engine} from './engine.js';
import {runTypecheck} from './typecheck.js';

interface CliArgs {
    opsFile: string;
    mode: 'dry' | 'apply';
    cwd: string;
    tsconfigPath?: string;
    srcDir?: string;
    skipTypecheck: boolean;
    quiet: boolean;
}

function printHelp(): void {
    const helpText = `front-renamer <ops.json> [options]

Declarative bulk refactor tool for TS/React repos. Moves files and folders,
rewrites imports, and renames identifiers via the TypeScript language service.

Arguments:
  <ops.json>           Path to a JSON file with refactor operations (see README).

Options:
  --apply              Commit changes to disk. Default is dry-run.
  --dry                Force dry-run (default).
  --cwd <path>         Project root. Default: current working directory.
  --tsconfig <path>    tsconfig file. Default: autodetect tsconfig.app.json
                       → tsconfig.json.
  --src <path>         Source directory to scan. Default: <cwd>/src.
  --skip-typecheck     Skip pre-/post-typecheck (faster, less safe).
  --quiet              Reduce output to errors and final status.
  -h, --help           Show this help.

Examples:
  npx front-renamer ops.json --dry
  npx front-renamer ops.json --apply
  npx front-renamer ops.json --apply --tsconfig tsconfig.build.json
`;
    process.stdout.write(helpText);
}

function parseArgs(argv: string[]): CliArgs {
    const positional: string[] = [];
    let mode: 'dry' | 'apply' = 'dry';
    let cwd = process.cwd();
    let tsconfigPath: string | undefined;
    let srcDir: string | undefined;
    let skipTypecheck = false;
    let quiet = false;

    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '-h' || a === '--help') {
            printHelp();
            process.exit(0);
        } else if (a === '--dry') mode = 'dry';
        else if (a === '--apply') mode = 'apply';
        else if (a === '--skip-typecheck') skipTypecheck = true;
        else if (a === '--quiet') quiet = true;
        else if (a === '--cwd') cwd = path.resolve(argv[++i]);
        else if (a === '--tsconfig') tsconfigPath = argv[++i];
        else if (a === '--src') srcDir = argv[++i];
        else if (a.startsWith('--')) throw new Error(`unknown flag: ${a}`);
        else positional.push(a);
    }
    if (positional.length !== 1) {
        printHelp();
        throw new Error(`expected exactly one positional argument (ops.json), got ${positional.length}`);
    }
    return {opsFile: positional[0], mode, cwd, tsconfigPath, srcDir, skipTypecheck, quiet};
}

function log(quiet: boolean, msg: string): void {
    if (!quiet) console.log(msg);
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const root = args.cwd;

    log(args.quiet, `[front-renamer] root=${root}`);
    log(args.quiet, `[front-renamer] ops=${args.opsFile}  mode=${args.mode}`);

    // Load project first — we need tsconfig path for the typecheck stage.
    const project = loadProject(root, {tsconfigPath: args.tsconfigPath, srcDir: args.srcDir});
    log(args.quiet, `[front-renamer] tsconfig=${path.relative(root, project.tsconfigPath)}  src=${path.relative(root, project.srcDir)}`);

    // -------- Stage 1: pre-typecheck --------
    if (!args.skipTypecheck) {
        log(args.quiet, '[1/6] pre-typecheck…');
        const pre = runTypecheck(project.tsconfigPath);
        if (!pre.ok) {
            process.stderr.write('✗ pre-typecheck failed. Fix existing errors first, then re-run.\n');
            process.stderr.write(pre.output);
            process.exit(1);
        }
        log(args.quiet, '     ✓ clean');
    } else {
        log(args.quiet, '[1/6] pre-typecheck SKIPPED');
    }

    // -------- Stage 2: load + validate ops --------
    log(args.quiet, '[2/6] loading ops…');
    const raw = JSON.parse(fs.readFileSync(path.resolve(root, args.opsFile), 'utf8')) as
        | OpsInput
        | RefactorOpInput[];
    const opsInput: RefactorOpInput[] = Array.isArray(raw) ? raw : raw.ops;
    const normalized = normalizeOps(opsInput, root);
    const errors = validateOps(normalized);
    if (errors.length > 0) {
        process.stderr.write('✗ validation errors:\n');
        for (const e of errors) {
            process.stderr.write(`    op#${e.index}: ${e.reason}  (${e.op.from} → ${e.op.to})\n`);
        }
        process.exit(1);
    }
    log(args.quiet, `     ✓ ${normalized.length} op(s) validated`);

    // -------- Stage 3: plan --------
    log(args.quiet, '[3/6] planning…');
    const plan = buildPlan(normalized);
    log(args.quiet, summarizePlan(plan).replace(/^/gm, '     '));
    if (plan.cycles.length > 0) {
        process.stderr.write('✗ cycles in plan, cannot proceed\n');
        process.exit(1);
    }

    // -------- Stage 4 + 5: in-memory engine --------
    log(args.quiet, '[4/6] applying ops in-memory…');
    const engine = new Engine(project);
    engine.applyToVFS(plan.levels);
    log(args.quiet, `     ${engine.summarize()}`);

    log(args.quiet, '[5/6] rewriting imports…');
    const {filesChanged} = engine.rewriteAllImports();
    log(args.quiet, `     ✓ ${filesChanged} file(s) had imports rewritten`);

    if (args.mode === 'dry') {
        log(args.quiet, '[6/6] DRY MODE — not committing to disk.');
        printDrySummary(engine, plan.levels.length, args.quiet);
        return;
    }

    // -------- Stage 6: commit + post-typecheck --------
    log(args.quiet, '[6/6] committing to disk (git mv + writeFile)…');
    engine.commit();
    log(args.quiet, '     ✓ commit complete');

    if (!args.skipTypecheck) {
        log(args.quiet, '     post-typecheck…');
        const post = runTypecheck(project.tsconfigPath);
        if (!post.ok) {
            process.stderr.write('✗ post-typecheck FAILED. Inspect manually:\n');
            process.stderr.write(post.output);
            process.exit(2);
        }
        log(args.quiet, '     ✓ post-typecheck clean');
    }
    log(args.quiet, 'Done.');
}

function printDrySummary(engine: Engine, levels: number, quiet: boolean): void {
    if (quiet) return;
    const moves: Array<{from: string; to: string}> = [];
    let edits = 0;
    for (const node of engine.tree.iterFiles()) {
        if (node.currentPath() !== node.initialPath()) {
            moves.push({from: node.initialPath(), to: node.currentPath()});
        }
        if (node.hasContentOverride()) edits++;
    }
    for (const node of engine.tree.iterDirs()) {
        if (node === engine.tree.root) continue;
        if (node.currentPath() !== node.initialPath()) {
            moves.push({from: node.initialPath(), to: node.currentPath()});
        }
    }
    console.log(`\n--- plan summary ---`);
    console.log(`phases:               ${levels}`);
    console.log(`relocations:          ${moves.length}`);
    console.log(`files with edits:     ${edits}`);
    console.log('\nfirst 10 relocations:');
    for (const {from, to} of moves.slice(0, 10)) {
        console.log(`  ${path.relative(engine.project.root, from)}\n  → ${path.relative(engine.project.root, to)}`);
    }
    if (moves.length > 10) console.log(`  …and ${moves.length - 10} more`);
}

main().catch((err) => {
    process.stderr.write(`FATAL: ${(err as Error).message}\n`);
    if (process.env.DEBUG) process.stderr.write((err as Error).stack + '\n');
    process.exit(99);
});
