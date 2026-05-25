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
import {execFileSync} from 'node:child_process';
import type {OpsInput, RefactorOpInput} from './schema.js';
import {loadProject, normalizeOps, validateOps} from './preflight.js';
import {buildPlan, summarizePlan} from './plan.js';
import {Engine} from './engine.js';
import {runTypecheck} from './typecheck.js';
import {resolveExtraPaths, rewriteExtraPaths} from './extra-paths.js';

interface CliArgs {
    opsFile: string;
    mode: 'dry' | 'apply';
    cwd: string;
    tsconfigPath?: string;
    srcDir?: string;
    skipTypecheck: boolean;
    quiet: boolean;
    rollback: boolean;
    prune: boolean;
    rewritePathsIn: string[];
    fullDiff: boolean;
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
  --no-rollback        Disable auto-rollback on post-typecheck failure.
                       (Default: rollback ON when working tree was clean.)
  --no-prune           Don't remove empty directories left behind by moves.
  --rewrite-paths-in <glob>
                       Additionally scan non-TS files (HTML, config, JSON,
                       Markdown) and substitute project-relative path
                       references that point to moved files. Repeatable.
                       Examples:
                         --rewrite-paths-in index.html
                         --rewrite-paths-in 'vite.config.ts'
  --diff               In dry-run, print every relocation and a sample of
                       import rewrites instead of the first 10 summary.
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
    let rollback = true;
    let prune = true;
    const rewritePathsIn: string[] = [];
    let fullDiff = false;

    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '-h' || a === '--help') {
            printHelp();
            process.exit(0);
        } else if (a === '--dry') mode = 'dry';
        else if (a === '--apply') mode = 'apply';
        else if (a === '--skip-typecheck') skipTypecheck = true;
        else if (a === '--no-rollback') rollback = false;
        else if (a === '--no-prune') prune = false;
        else if (a === '--diff') fullDiff = true;
        else if (a === '--quiet') quiet = true;
        else if (a === '--cwd') cwd = path.resolve(argv[++i]);
        else if (a === '--tsconfig') tsconfigPath = argv[++i];
        else if (a === '--src') srcDir = argv[++i];
        else if (a === '--rewrite-paths-in') rewritePathsIn.push(argv[++i]);
        else if (a.startsWith('--')) throw new Error(`unknown flag: ${a}`);
        else positional.push(a);
    }
    if (positional.length !== 1) {
        printHelp();
        throw new Error(`expected exactly one positional argument (ops.json), got ${positional.length}`);
    }
    return {
        opsFile: positional[0],
        mode,
        cwd,
        tsconfigPath,
        srcDir,
        skipTypecheck,
        quiet,
        rollback,
        prune,
        rewritePathsIn,
        fullDiff,
    };
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

    // Snapshot for potential rollback. Only useful when working tree was clean
    // (otherwise rolling back would also wipe the user's unrelated changes).
    let rollbackSha: string | null = null;
    if (args.mode === 'apply' && args.rollback) {
        if (isGitRepo(root) && isCleanGitTree(root)) {
            rollbackSha = gitHeadSha(root);
            log(args.quiet, `[rollback] snapshot ${rollbackSha?.slice(0, 7)} (clean tree)`);
        } else if (isGitRepo(root)) {
            log(args.quiet, '[rollback] disabled (working tree not clean) — pass --no-rollback to silence');
        }
    }

    // -------- Stage 4 + 5: in-memory engine --------
    log(args.quiet, '[4/6] applying ops in-memory…');
    const engine = new Engine(project);
    engine.pruneEmptyDirs = args.prune;
    engine.applyToVFS(plan.levels);
    log(args.quiet, `     ${engine.summarize()}`);

    log(args.quiet, '[5/6] rewriting imports…');
    const {filesChanged} = engine.rewriteAllImports();
    log(args.quiet, `     ✓ ${filesChanged} file(s) had imports rewritten`);

    if (args.mode === 'dry') {
        log(args.quiet, '[6/6] DRY MODE — not committing to disk.');
        printDrySummary(engine, plan.levels.length, args.quiet, args.fullDiff);
        return;
    }

    // -------- Stage 6: commit + post-typecheck --------
    log(args.quiet, '[6/6] committing to disk (git mv + writeFile)…');
    engine.commit();
    log(args.quiet, '     ✓ commit complete');

    if (args.rewritePathsIn.length > 0) {
        const extraFiles = resolveExtraPaths(root, args.rewritePathsIn);
        log(args.quiet, `     rewriting paths in ${extraFiles.length} extra file(s)…`);
        const {hits, changed} = rewriteExtraPaths(extraFiles, engine.tree, root);
        log(args.quiet, `     ✓ ${changed} extra file(s) updated`);
        if (!args.quiet) {
            for (const h of hits.slice(0, 10)) {
                console.log(`       ${path.relative(root, h.file)}: ${h.replaced} replacement(s)`);
            }
            if (hits.length > 10) console.log(`       …and ${hits.length - 10} more`);
        }
    }

    if (!args.skipTypecheck) {
        log(args.quiet, '     post-typecheck…');
        const post = runTypecheck(project.tsconfigPath);
        if (!post.ok) {
            process.stderr.write('✗ post-typecheck FAILED.\n');
            process.stderr.write(post.output);
            if (rollbackSha) {
                process.stderr.write(`\n[rollback] reverting to ${rollbackSha.slice(0, 7)}…\n`);
                try {
                    execFileSync('git', ['reset', '--hard', rollbackSha], {cwd: root, stdio: 'pipe'});
                    execFileSync('git', ['clean', '-fd'], {cwd: root, stdio: 'pipe'});
                    process.stderr.write('[rollback] working tree restored.\n');
                } catch (err) {
                    process.stderr.write(`[rollback] failed: ${(err as Error).message}\n`);
                }
            } else {
                process.stderr.write('[rollback] not available — inspect changes manually.\n');
            }
            process.exit(2);
        }
        log(args.quiet, '     ✓ post-typecheck clean');
    }
    log(args.quiet, 'Done.');
}

function isGitRepo(root: string): boolean {
    try {
        execFileSync('git', ['rev-parse', '--git-dir'], {cwd: root, stdio: 'pipe'});
        return true;
    } catch {
        return false;
    }
}

function isCleanGitTree(root: string): boolean {
    try {
        const out = execFileSync('git', ['status', '--porcelain'], {cwd: root, encoding: 'utf8'});
        return out.trim() === '';
    } catch {
        return false;
    }
}

function gitHeadSha(root: string): string | null {
    try {
        return execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim();
    } catch {
        return null;
    }
}

function printDrySummary(engine: Engine, levels: number, quiet: boolean, fullDiff: boolean): void {
    if (quiet) return;
    const moves: Array<{from: string; to: string}> = [];
    const edits: Array<{node: import('./vfs.js').FsNode; size: number}> = [];
    for (const node of engine.tree.iterFiles()) {
        if (node.currentPath() !== node.initialPath()) {
            moves.push({from: node.initialPath(), to: node.currentPath()});
        }
        if (node.hasContentOverride()) {
            edits.push({node, size: node.readContent().length});
        }
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
    console.log(`files with edits:     ${edits.length}`);

    const showN = fullDiff ? moves.length : Math.min(10, moves.length);
    console.log(`\nrelocations (${showN}${fullDiff ? '' : ` of ${moves.length}`}):`);
    for (const {from, to} of moves.slice(0, showN)) {
        console.log(`  ${path.relative(engine.project.root, from)}\n  → ${path.relative(engine.project.root, to)}`);
    }
    if (!fullDiff && moves.length > showN) console.log(`  …and ${moves.length - showN} more (use --diff to see all)`);

    if (fullDiff) {
        const editsShow = Math.min(20, edits.length);
        console.log(`\nedited files (${editsShow}${edits.length > editsShow ? ` of ${edits.length}` : ''}):`);
        for (const e of edits.slice(0, editsShow)) {
            const rel = path.relative(engine.project.root, e.node.currentPath());
            const lineDiffs = computeLineDiff(e.node.initialPath(), e.node.readContent());
            console.log(`\n  ${rel}  (${lineDiffs.length} line(s) changed, ${e.size} bytes total)`);
            for (const d of lineDiffs.slice(0, 8)) {
                console.log(`    \x1b[31m- ${d.before}\x1b[0m`);
                console.log(`    \x1b[32m+ ${d.after}\x1b[0m`);
            }
            if (lineDiffs.length > 8) console.log(`    …and ${lineDiffs.length - 8} more line change(s)`);
        }
        if (edits.length > editsShow) console.log(`  …and ${edits.length - editsShow} more`);
    }
}

function computeLineDiff(originalPath: string, currentContent: string): Array<{line: number; before: string; after: string}> {
    let originalContent: string;
    try {
        originalContent = fs.readFileSync(originalPath, 'utf8');
    } catch {
        return [];
    }
    const origLines = originalContent.split('\n');
    const curLines = currentContent.split('\n');
    const out: Array<{line: number; before: string; after: string}> = [];
    // Identifier renames and import rewrites preserve line count, so a simple
    // line-by-line comparison is enough to surface the actual edits.
    const max = Math.min(origLines.length, curLines.length);
    for (let i = 0; i < max; i++) {
        if (origLines[i] !== curLines[i]) {
            out.push({line: i + 1, before: origLines[i].trim(), after: curLines[i].trim()});
        }
    }
    // If line counts diverged (rare), append the tail as before/empty or empty/after.
    if (origLines.length !== curLines.length) {
        for (let i = max; i < Math.max(origLines.length, curLines.length); i++) {
            out.push({
                line: i + 1,
                before: i < origLines.length ? origLines[i].trim() : '',
                after: i < curLines.length ? curLines[i].trim() : '',
            });
        }
    }
    return out;
}

main().catch((err) => {
    process.stderr.write(`FATAL: ${(err as Error).message}\n`);
    if (process.env.DEBUG) process.stderr.write((err as Error).stack + '\n');
    process.exit(99);
});
