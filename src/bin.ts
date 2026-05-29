#!/usr/bin/env node
/**
 * front-renamer CLI.
 *
 *   front-renamer <ops.json | '<inline-json>'> [options]
 *
 * The positional argument is either a path to a JSON file OR an inline JSON
 * literal (auto-detected by a leading `[` or `{`) — useful for one-off ops
 * without a temp file:
 *
 *   front-renamer '[["src/a.tsx","src/b.tsx"]]' --apply
 *
 * Options:
 *   --apply              Commit changes to disk (default is dry-run).
 *   --dry                Force dry-run mode (default).
 *   --cwd <path>         Project root. Default: current working directory.
 *   --tsconfig <path>    tsconfig file. Default: autodetect tsconfig.app.json → tsconfig.json.
 *   --src <path>         Source directory to scan. Default: <root>/src.
 *   --skip-typecheck     Skip pre-/post-typecheck (faster, less safe).
 *   --strict             Hard-fail on first op error (default: continue).
 *   -h, --help           Show this help.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as util from 'node:util';
import {execFileSync} from 'node:child_process';
import {createPatch} from 'diff';
import type {RefactorOpInput} from './schema.js';
import {expandExtractTemplates, loadProject, normalizeOps, validateOps, validateRawOps} from './preflight.js';
import {buildPlan} from './plan.js';
import {Engine} from './engine.js';
import {runTypecheck} from './typecheck.js';
import {resolveExtraPaths, rewriteExtraPaths} from './extra-paths.js';
import {initProjectTypescript} from './ts-loader.js';
import {loadProjectPrettier} from './prettier-loader.js';
import {buildRunReport, writeRunReport, type RunReport} from './report.js';

interface CliArgs {
    opsFile: string;
    mode: 'dry' | 'apply';
    cwd: string;
    tsconfigPath?: string;
    srcDir?: string;
    skipTypecheck: boolean;
    rollback: boolean;
    prune: boolean;
    rewritePathsIn: string[];
    continueOnError: boolean;
    /** Template applied to extract ops that omit `to` (e.g. `{dir}/{symbol}/{symbol}.tsx`). */
    extractTo?: string;
    /** Path to write a machine-readable JSON report; `undefined` = don't write. */
    reportJson?: string;
}

function printHelp(): void {
    const helpText = `front-renamer <ops.json | inline-json> [options]

Declarative bulk refactor tool for TS/React repos. Moves files and folders,
rewrites imports, and renames identifiers via the TypeScript language service.

Arguments:
  <ops>                Either a PATH to a JSON file with refactor operations,
                       OR an inline JSON literal (auto-detected by a leading
                       \`[\` or \`{\`). Quote the inline form to keep the shell
                       from mangling it:
                         front-renamer '[["src/a.tsx","src/b.tsx"]]' --apply

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
  --strict             Hard-fail on the first op that errors instead of
                       collecting failures into a final report. (Default
                       behaviour is to keep going — this IS a batch tool.)
  --extract-to <pat>   Template applied to extract ops that omit "to".
                       Vars: {symbol}, {dir}, {stem}, {ext}, {parent}, {name}
                       + filters lc / uc / kebab / strip:S / stripPrefix:P.
                       Example: "{dir}/{symbol}/{symbol}.tsx"
                       lets you write { "extract": "Header", "from": "..." }
                       without spelling out the destination per op.
  --report-json <path> Write a machine-readable run report to <path>. Useful
                       for CI gates (\`jq '.ops.failed' < report.json\`) and
                       for generating a follow-up ops.json from only the
                       failed entries. Format is stable and documented.
  -h, --help           Show this help.

Examples:
  npx front-renamer ops.json --dry
  npx front-renamer ops.json --apply
  npx front-renamer ops.json --apply --tsconfig tsconfig.build.json
  npx front-renamer '[["src/old","src/new"]]' --apply
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
    let rollback = true;
    let prune = true;
    const rewritePathsIn: string[] = [];
    // Default is continue-on-error — this is a batch tool, one bad op shouldn't
    // wipe out the progress of the other 100. `--strict` flips this off for
    // workflows that want all-or-nothing semantics.
    let continueOnError = true;
    let extractTo: string | undefined;
    let reportJson: string | undefined;

    const takeValue = (flag: string, i: number): string => {
        const v = argv[i + 1];
        if (v === undefined || v.startsWith('--')) {
            throw new Error(`flag ${flag} requires a value`);
        }
        return v;
    };

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
        else if (a === '--strict') continueOnError = false;
        else if (a === '--extract-to') extractTo = takeValue('--extract-to', i++);
        else if (a === '--report-json') reportJson = takeValue('--report-json', i++);
        else if (a === '--cwd') cwd = path.resolve(takeValue('--cwd', i++));
        else if (a === '--tsconfig') tsconfigPath = takeValue('--tsconfig', i++);
        else if (a === '--src') srcDir = takeValue('--src', i++);
        else if (a === '--rewrite-paths-in') rewritePathsIn.push(takeValue('--rewrite-paths-in', i++));
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
        rollback,
        prune,
        rewritePathsIn,
        continueOnError,
        extractTo,
        reportJson,
    };
}


async function main() {
    // Wall-clock for the elapsed-time stamp at the end. We capture monotonic
    // time (`performance.now`) so a system clock jump mid-run can't produce a
    // negative or absurdly inflated duration.
    const startMs = performance.now();
    const startedAt = new Date();
    const args = parseArgs(process.argv.slice(2));
    const root = args.cwd;

    // When the user didn't ask for a structured `--report-json`, mirror the
    // entire console output to a temp log file. Lets them re-read the run
    // afterwards without re-running it (the 30-second batch is not free) and
    // gives reviewers / agents a single file they can attach to a bug report.
    // We hook BEFORE any console.log fires so even the header lands in the
    // log. Sync writes — process.exit() doesn't run finalizers.
    const logPath = args.reportJson ? null : openConsoleLog();

    // Run-report state — accumulated as stages complete, written to disk at
    // any exit point when `--report-json` was passed. Wrapping in a closure
    // means every exit site calls one helper instead of re-assembling the
    // report shape inline.
    const reportState: ReportState = {
        importsFilesRewritten: 0,
        prettier: {available: false, reason: 'not run'},
        rollback: {armed: false, sha: null},
        diffPath: null,
    };

    // Resolve the project's TypeScript BEFORE anything else — every downstream
    // module imports `ts` from ts-loader, which late-binds. Doing this here
    // means parse-tsconfig, language-service, typecheck, post-process — all
    // run against the version the project actually uses, not whatever we bundle.
    const tsRes = initProjectTypescript(root);

    // Load project first — we need tsconfig path for the typecheck stage.
    const project = loadProject(root, {tsconfigPath: args.tsconfigPath, srcDir: args.srcDir});
    const srcRel = path.relative(root, project.srcDir);
    setSrcDirRel(srcRel);

    // Apply mode hard-refuses a dirty git tree — mixing front-renamer's edits
    // with the user's uncommitted work makes review impossible and rollback
    // would clobber their changes. They must commit or stash first.
    if (args.mode === 'apply' && isGitRepo(root) && !isCleanGitTree(root)) {
        console.log('✗ working tree is not clean — refusing to run in --apply mode.');
        console.log('  Commit or stash your changes first, then re-run. This protects you:');
        console.log('  rollback on post-typecheck failure would discard the uncommitted work.');
        console.log('');
        console.log('  git status:');
        const out = execFileSync('git', ['status', '--short'], {cwd: root, encoding: 'utf8'});
        for (const line of out.trimEnd().split('\n')) console.log(`    ${line}`);
        process.exit(1);
    }

    // Compute rollback eligibility eagerly — it's setup info, not a runtime
    // stage, so it belongs in the header block alongside root/ops/tsconfig.
    let rollbackSha: string | null = null;
    let rollbackStatus = 'off';
    if (args.mode === 'apply' && args.rollback) {
        if (isGitRepo(root)) {
            rollbackSha = gitHeadSha(root);
            rollbackStatus = `armed at ${rollbackSha?.slice(0, 7)}`;
            reportState.rollback = {armed: true, sha: rollbackSha};
        } else {
            rollbackStatus = 'unavailable (not a git repo)';
        }
    }

    const modeBadge = args.mode === 'dry' ? '(dry-run)' : '(apply)';
    const opsTrim = args.opsFile.trimStart();
    const opsHeader = opsTrim.startsWith('[') || opsTrim.startsWith('{') ? '(inline)' : args.opsFile;
    console.log(`front-renamer ${modeBadge}`);
    console.log(`  root      ${root}`);
    console.log(`  ops       ${opsHeader}`);
    console.log(`  tsconfig  ${path.relative(root, project.tsconfigPath)}`);
    console.log(`  ts        ${tsRes.version} (${tsRes.from})`);
    // Show src only when non-default — otherwise it's noise (every path
    // already begins with it AND we'll be stripping it from path lines).
    if (srcRel !== 'src') console.log(`  src       ${srcRel}`);
    if (args.mode === 'apply') console.log(`  rollback  ${rollbackStatus}`);
    console.log('');

    // -------- Stage 1: load + schema-validate ops --------
    // Schema check FIRST — no point spending ~15s on pre-typecheck if the
    // ops file itself is broken (typos in field names, wrong types, missing
    // required fields, `from` paths that don't exist). Surfaces all problems
    // in one pass so the user can fix them at once.
    //
    // The positional argument can be EITHER a file path or inline JSON (so
    // quick one-off batches don't need a temp file). Auto-detect on the
    // first non-whitespace character — `[` or `{` means JSON literal.
    const opsSource = readOpsSource(args.opsFile, root);
    // Render `to` for extract ops that either omit it (and we have a CLI
    // pattern) OR carry a template literal of their own. Template errors AND
    // schema errors surface together — user sees all problems in one pass
    // instead of fixing one, re-running, finding the next.
    const tmplErrors = expandExtractTemplates(opsSource.opsArray, args.extractTo);
    const schemaErrors = validateRawOps(opsSource.opsArray, root);
    const allRawErrors = [...tmplErrors, ...schemaErrors];
    if (allRawErrors.length > 0) {
        console.log(`✗ ${allRawErrors.length} schema error(s) in ${opsSource.label}:`);
        for (const e of allRawErrors) {
            const tag = e.index < 0 ? 'ops' : `op#${e.index}`;
            console.log(`    ${tag}: ${e.reason}`);
        }
        process.exit(1);
    }
    const opsArray = opsSource.opsArray;

    const opsInput = opsArray as RefactorOpInput[];
    const normalized = normalizeOps(opsInput, root);
    const errors = validateOps(normalized);
    if (errors.length > 0) {
        console.log('✗ validation errors:');
        for (const e of errors) {
            console.log(`    op#${e.index}: ${e.reason}  (${formatFromTo(e.op.from, e.op.to)})`);
        }
        process.exit(1);
    }
    console.log(`✓ ${normalized.length} op(s) validated`);

    // -------- Stage 2: pre-typecheck --------
    if (!args.skipTypecheck) {
        const pre = runTypecheck(project.tsconfigPath);
        if (!pre.ok) {
            console.log('✗ pre-typecheck failed. Fix existing errors first, then re-run.');
            console.log(pre.output);
            process.exit(1);
        }
        console.log('✓ pre-typecheck clean');
    } else {
        console.log('· pre-typecheck skipped');
    }

    // -------- Stage 3: plan --------
    const plan = buildPlan(normalized);
    if (plan.cycles.length > 0) {
        console.log('✗ cycles in plan, cannot proceed');
        process.exit(1);
    }
    console.log(`✓ plan: ${plan.levels.length} phase(s)`);

    // -------- Stage 4 + 5: in-memory engine --------
    // Wrap in try/finally so disk stubs are cleaned up even if a stage throws.
    const engine = new Engine(project);
    engine.pruneEmptyDirs = args.prune;
    engine.continueOnError = args.continueOnError;
    let succeeded = false;
    try {
        engine.applyToVFS(plan.levels);
        console.log(`✓ applied ${engine.appliedOps.length}/${normalized.length} op(s) in-memory`);

        // Catch consumer files (typically those created by earlier extracts in
        // this batch) whose imports the TS LS couldn't reach.
        engine.rewriteExtractSymbolConsumers();

        const {filesChanged} = engine.rewriteAllImports();
        reportState.importsFilesRewritten = filesChanged;
        console.log(`✓ imports rewritten in ${filesChanged} file(s)`);
        // Final post-process sweep — fixes verbatimModuleSyntax violations,
        // `.ts` extension leakage, and `/node_modules/...` paths across ALL
        // files affected by extract ops (not just the targets of the last op).
        engine.postProcessExtractTouched();

        // Run the project's prettier over every touched file (works in both
        // dry and apply modes — formats VFS content, not disk). Final diff /
        // commit see the formatted bytes, matching what the project's lint
        // setup expects. Skipped automatically when prettier isn't installed.
        const prettier = await loadProjectPrettier(root);
        if (prettier.available) {
            const {formatted, skipped, failed} = await engine.formatTouchedFiles(prettier.formatFile);
            reportState.prettier = {
                available: true,
                version: prettier.version,
                formatted,
                skipped,
                failed: failed.map((f) => ({path: f.path, reason: f.reason})),
            };
            const skipNote = skipped > 0 ? `, ${skipped} skipped` : '';
            const failNote = failed.length > 0 ? `, ${failed.length} failed` : '';
            console.log(`✓ prettier ${prettier.version} (${formatted} file(s) formatted${skipNote}${failNote})`);
            // Surface formatting failures inline — one bad `.prettierrc`
            // override per file shouldn't kill the batch, but the user needs
            // to see WHICH files weren't formatted and WHY (so they can fix
            // the config or accept the unformatted state).
            for (const f of failed) {
                console.log(`    ⚠ ${stripSrc(path.relative(root, f.path))}: ${f.reason}`);
            }
        } else {
            reportState.prettier = {available: false, reason: prettier.reason};
            console.log(`· prettier ${prettier.reason}`);
        }

        if (args.mode === 'dry') {
            console.log('· dry-run — not writing to disk');
            // Run post-typecheck against the VFS overlay so the user sees what
            // would break BEFORE committing. Uses the same formatter as
            // apply-mode → identical output format.
            const dryOk = runDryPostTypecheck(args, project, engine);
            const diffPath = writeUnifiedDiff(engine);
            reportState.diffPath = diffPath;
            // Promote the diff path into the stage-log band — used to live
            // only in `=== summary ===`, easy to scroll past when reading top-
            // down. Keep the summary line too (for `grep ^diff`-style consumers).
            if (diffPath) console.log(`✓ diff written to ${diffPath}`);
            printDrySummary(engine, plan.levels.length, diffPath);
            printCssReports(engine);
            printWarningReport(engine);
            printFailureReport(engine);
            succeeded = true;
            // Exit 2 on dry typecheck failure — same code apply-mode uses.
            // Reports still print first so the user sees what would have shipped.
            if (!dryOk) {
                writeReportIfRequested(args, {
                    engine, mode: 'dry', startedAt, elapsedMs: performance.now() - startMs,
                    exitCode: 2, state: reportState,
                });
                printElapsed(startMs, '✗', logPath);
                process.exit(2);
            }
            writeReportIfRequested(args, {
                engine, mode: 'dry', startedAt, elapsedMs: performance.now() - startMs,
                exitCode: 0, state: reportState,
            });
            printElapsed(startMs, '✓', logPath);
            return;
        }

        // -------- Stage 6: commit + post-typecheck (INSIDE try so a mid-commit
        // throw still triggers stub cleanup AND attempts rollback) --------
        // Capture diff BEFORE commit — once files are on disk the "before"
        // content is gone.
        const diffPath = writeUnifiedDiff(engine);
        reportState.diffPath = diffPath;
        if (diffPath) console.log(`✓ diff written to ${diffPath}`);
        engine.commit();
        console.log('✓ committed to disk');

        if (args.rewritePathsIn.length > 0) {
            const extraFiles = resolveExtraPaths(root, args.rewritePathsIn);
            const {hits, changed} = rewriteExtraPaths(extraFiles, engine.tree, root);
            console.log(`✓ rewrote paths in ${changed}/${extraFiles.length} extra file(s)`);
            for (const h of hits) {
                console.log(`    ${path.relative(root, h.file)}: ${h.replaced} replacement(s)`);
            }
        }

        // Post-typecheck runs INSIDE the stage-log cluster so all the `✓ … ` /
        // `· …` lines stay together at the top — otherwise the result lands
        // after `=== summary ===` and looks like an afterthought.
        const postOk = runPostTypecheckOrRollback(args, project, rollbackSha);

        // Same applied/failed breakdown in apply mode — without it the user
        // can't tell what made it through.
        printDrySummary(engine, plan.levels.length, diffPath);
        printCssReports(engine);
        printFailureReport(engine);
        succeeded = true;
        if (!postOk.ok) {
            writeReportIfRequested(args, {
                engine, mode: 'apply', startedAt, elapsedMs: performance.now() - startMs,
                exitCode: 2, state: reportState,
            });
            printElapsed(startMs, '✗', logPath);
            process.exit(2);
        }
    } catch (err) {
        // Stage failed (typically a strict-mode op error). The engine already
        // pushed a structured entry into `opFailures` for any per-op throw, so
        // we render through the SAME `printFailureReport` path used in
        // continue-mode — no second formatter, no raw Error.message dumped at
        // the user.
        if (engine.opFailures.length > 0) {
            printWarningReport(engine);
            printFailureReport(engine);
        } else {
            // Unstructured throw (env issue, plan bug, etc.) — surface the
            // raw message; no per-op entry exists to format.
            console.log(`\n✗ aborted: ${(err as Error).message}`);
        }

        if (args.mode === 'apply' && rollbackSha) {
            console.log(`\n[rollback] error during apply — reverting to ${rollbackSha.slice(0, 7)}…`);
            try {
                execFileSync('git', ['reset', '--hard', rollbackSha], {cwd: root, stdio: 'pipe'});
                execFileSync('git', ['clean', '-fd'], {cwd: root, stdio: 'pipe'});
                console.log('[rollback] working tree restored.');
            } catch (rbErr) {
                console.log(`[rollback] failed: ${(rbErr as Error).message}`);
            }
        }
        writeReportIfRequested(args, {
            engine, mode: args.mode, startedAt, elapsedMs: performance.now() - startMs,
            exitCode: 2, state: reportState,
        });
        printElapsed(startMs, '✗', logPath);
        // Exit cleanly — we've already printed the user-visible report. Don't
        // rethrow into main().catch where the FATAL handler would print the
        // raw Error message a second time.
        process.exit(2);
    } finally {
        // Dry: always. Apply on failure: cleanup so stubs don't leak.
        // Apply on success: stubs overwritten by commit, but the createdDirs
        // cleanup still rmdir's empty dirs — safe to call.
        if (args.mode === 'dry' || !succeeded) {
            engine.cleanupExtractStubs();
        }
    }

    // Apply-mode post-typecheck already ran inside the try block above. Dry
    // mode returns early — no commit on disk to typecheck.
    writeReportIfRequested(args, {
        engine, mode: args.mode, startedAt, elapsedMs: performance.now() - startMs,
        exitCode: 0, state: reportState,
    });
    printElapsed(startMs, '✓', logPath);
}

/** Final status line with elapsed time. One helper avoids drift across exit paths. */
function printElapsed(startMs: number, marker: '✓' | '✗', logPath?: string | null): void {
    const tail = logPath ? `  (log: ${logPath})` : '';
    console.log(`\n${marker} done (${formatElapsed(performance.now() - startMs)})${tail}`);
}

/**
 * Open a temp log file and tee `console.log` to it. Returns the path so the
 * caller can print it alongside `done`. Re-entry is safe — only hooks once.
 *
 * Object args are formatted via `util.format` so they don't degrade to
 * `[object Object]` (a common surprise when piping `console.log({…})`).
 */
let consoleLogHooked = false;
function openConsoleLog(): string {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const logPath = path.join(os.tmpdir(), `front-renamer-log-${stamp}.log`);
    const fd = fs.openSync(logPath, 'w');
    if (consoleLogHooked) return logPath;
    consoleLogHooked = true;
    const orig = console.log.bind(console);
    console.log = (...inputs: unknown[]): void => {
        orig(...inputs);
        // `util.format` matches what console.log itself emits to the terminal,
        // so the file is byte-faithful to what the user saw.
        try {
            fs.writeSync(fd, util.format(...inputs) + '\n');
        } catch {
            /* a closed fd or full disk shouldn't crash the run */
        }
    };
    return logPath;
}

/** Mutable state accumulated as stages run — folded into the final RunReport. */
interface ReportState {
    importsFilesRewritten: number;
    prettier: RunReport['prettier'];
    rollback: RunReport['rollback'];
    diffPath: string | null;
}

/**
 * Write the run report when `--report-json` was passed. Tolerant of partial
 * state — early-exit paths (validation failure, dirty git tree) skip report
 * writing because there's no `engine` yet; pass `null` to indicate that.
 */
function writeReportIfRequested(args: {reportJson?: string}, opts: {
    engine: Engine | null;
    mode: 'dry' | 'apply';
    startedAt: Date;
    elapsedMs: number;
    exitCode: number;
    state: ReportState;
}): void {
    if (!args.reportJson || !opts.engine) return;
    try {
        const report = buildRunReport({
            engine: opts.engine,
            mode: opts.mode,
            startedAt: opts.startedAt,
            elapsedMs: opts.elapsedMs,
            exitCode: opts.exitCode,
            version: FRONT_RENAMER_VERSION,
            diffPath: opts.state.diffPath,
            importsFilesRewritten: opts.state.importsFilesRewritten,
            prettier: opts.state.prettier,
            rollback: opts.state.rollback,
            docsUrlFor: categoryDocsUrl,
        });
        writeRunReport(args.reportJson, report);
        console.log(`✓ report written to ${args.reportJson}`);
    } catch (err) {
        // Don't fail the run just because the report file couldn't be
        // written — surface it and keep going.
        console.log(`⚠ failed to write report: ${(err as Error).message}`);
    }
}

/** Version stamped into the report. Read once from our package.json at startup. */
const FRONT_RENAMER_VERSION: string = readSelfVersion();
function readSelfVersion(): string {
    try {
        // dist/bin.js lives one level deeper than dist; package.json is the
        // sibling of dist/.
        const here = new URL('.', import.meta.url).pathname;
        const pkg = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8'));
        return typeof pkg.version === 'string' ? pkg.version : 'unknown';
    } catch {
        return 'unknown';
    }
}

/** Human-readable elapsed time. Sub-second → ms; otherwise `Ns` or `Mm Ns`. */
function formatElapsed(ms: number): string {
    if (ms < 1000) return `${Math.round(ms)}ms`;
    const totalSec = ms / 1000;
    if (totalSec < 60) return `${totalSec.toFixed(1)}s`;
    const m = Math.floor(totalSec / 60);
    const s = Math.round(totalSec - m * 60);
    return `${m}m ${s}s`;
}

/**
 * Dry-run post-typecheck — typecheck the in-memory post-batch state without
 * committing anything to disk. Same formatter as apply-mode → identical output
 * format. Returns true if clean. Caller decides on exit code so that the
 * summary/diff/failure reports can print first.
 */
function runDryPostTypecheck(
    args: CliArgs,
    project: import('./preflight.js').ProjectInfo,
    engine: Engine,
): boolean {
    if (args.skipTypecheck) {
        console.log('· post-typecheck skipped');
        return true;
    }
    const overlay = engine.collectTypecheckOverlay();
    const post = runTypecheck(project.tsconfigPath, overlay);
    if (post.ok) {
        console.log('✓ post-typecheck clean (in-memory overlay)');
        return true;
    }
    console.log('✗ post-typecheck FAILED (would not compile after commit).');
    console.log(post.output);
    return false;
}

/**
 * Run post-typecheck on the committed disk state and roll back if it fails.
 * Returns `{ok}` — caller decides on exit code and report writing.
 */
function runPostTypecheckOrRollback(
    args: CliArgs,
    project: import('./preflight.js').ProjectInfo,
    rollbackSha: string | null,
): {ok: boolean} {
    if (args.skipTypecheck) {
        console.log('· post-typecheck skipped');
        return {ok: true};
    }
    const post = runTypecheck(project.tsconfigPath);
    if (post.ok) {
        console.log('✓ post-typecheck clean');
        return {ok: true};
    }
    console.log('✗ post-typecheck FAILED.');
    console.log(post.output);
    if (rollbackSha) {
        console.log(`\n[rollback] reverting to ${rollbackSha.slice(0, 7)}…`);
        try {
            execFileSync('git', ['reset', '--hard', rollbackSha], {cwd: args.cwd, stdio: 'pipe'});
            execFileSync('git', ['clean', '-fd'], {cwd: args.cwd, stdio: 'pipe'});
            console.log('[rollback] working tree restored.');
        } catch (err) {
            console.log(`[rollback] failed: ${(err as Error).message}`);
        }
    } else {
        console.log('[rollback] not available — inspect changes manually.');
    }
    return {ok: false};
}

/**
 * Resolve the positional arg into a parsed ops array + a human-readable label
 * for diagnostics. Auto-detects inline JSON (`[…]` or `{…}` as the very first
 * non-whitespace char) so small batches don't need a temp file. Exits
 * cleanly on bad JSON / unknown shape — no raw `Unexpected token` for the
 * user to decode.
 */
function readOpsSource(positional: string, root: string): {opsArray: unknown; label: string} {
    const trimmed = positional.trimStart();
    const inline = trimmed.startsWith('[') || trimmed.startsWith('{');
    const label = inline ? '(inline)' : positional;
    let text: string;
    if (inline) {
        text = positional;
    } else {
        const opsFilePath = path.resolve(root, positional);
        try {
            text = fs.readFileSync(opsFilePath, 'utf8');
        } catch (err) {
            console.log(`✗ failed to read ${positional}: ${(err as Error).message}`);
            process.exit(1);
        }
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch (err) {
        console.log(`✗ failed to parse ${label}: ${(err as Error).message}`);
        process.exit(1);
    }
    const opsArray: unknown = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === 'object' && 'ops' in (parsed as Record<string, unknown>)
        ? (parsed as {ops: unknown}).ops
        : null;
    if (opsArray === null) {
        console.log(`✗ ${label}: must be an array of ops, or an object with an "ops" array`);
        process.exit(1);
    }
    return {opsArray, label};
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

function printDrySummary(engine: Engine, levels: number, diffPath: string | null): void {
    // Drive the summary from `engine.appliedOps` — the actual list of ops from
    // ops.json that succeeded — split by kind. Walking the tree conflates
    // extract-created files with file moves (extracted file's "initial path"
    // is the LS-chosen sibling name, which looks like a fictitious source).
    const moves: Array<import('./schema.js').NormalizedMoveOp> = [];
    const movesWithRename: Array<import('./schema.js').NormalizedMoveOp> = [];
    const extracts: Array<import('./schema.js').NormalizedExtractOp> = [];
    for (const op of engine.appliedOps) {
        if (op.kind === 'extract') extracts.push(op);
        else if (op.renameSymbols.length > 0) movesWithRename.push(op);
        else moves.push(op);
    }

    let edits = 0;
    for (const node of engine.tree.iterFiles()) {
        if (node.hasContentOverride()) edits++;
    }

    const total = engine.appliedOps.length + engine.opFailures.length;
    console.log(`\n=== summary ===`);
    console.log(`phases:           ${levels}`);
    console.log(`ops total:        ${total}`);
    console.log(`  ✓ applied:      ${engine.appliedOps.length}  (moves: ${moves.length}, moves+rename: ${movesWithRename.length}, extracts: ${extracts.length})`);
    console.log(`  ✗ failed:       ${engine.opFailures.length}`);
    console.log(`files with edits: ${edits}`);
    if (diffPath) console.log(`diff:             ${diffPath}`);

    if (engine.appliedOps.length === 0) return;
    console.log(`\n=== ✓ applied ops (${engine.appliedOps.length}) ===`);

    if (moves.length > 0) {
        console.log(`\n  moves (${moves.length}):`);
        for (const op of moves) {
            console.log(`    op#${op.index}  ${formatFromTo(op.from, op.to, op.fromAbs, op.toAbs)}`);
        }
    }

    if (movesWithRename.length > 0) {
        console.log(`\n  moves + rename (${movesWithRename.length}):`);
        for (const op of movesWithRename) {
            const renames = op.renameSymbols.map((r) => `${r.old}→${r.new}`).join(', ');
            console.log(`    op#${op.index}  ${formatFromTo(op.from, op.to, op.fromAbs, op.toAbs)}  (rename: ${renames})`);
        }
    }

    if (extracts.length > 0) {
        console.log(`\n  extracts (${extracts.length}):`);
        for (const op of extracts) {
            console.log(`    op#${op.index}  ${op.extract}  ${formatFromTo(op.from, op.to, op.fromAbs, op.toAbs)}`);
        }
    }
}

/**
 * Build a unified diff of every edited file and write it to a temp file. Per
 * file: a standard `--- a/path` / `+++ b/path` header followed by hunks via
 * the `diff` package's Myers LCS — same shape `git diff` produces, so editors
 * and reviewers pick it up automatically.
 *
 * Streaming-style implementation (open the file once, append per-node) so a
 * batch with hundreds of files doesn't materialise the full patch in memory.
 *
 * Returns the absolute path of the patch file, or null if there were no edits.
 */
function writeUnifiedDiff(engine: Engine): string | null {
    const edited: Array<import('./vfs.js').FsNode> = [];
    for (const node of engine.tree.iterFiles()) {
        if (node.hasContentOverride()) edited.push(node);
    }
    if (edited.length === 0) return null;

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const out = path.join(os.tmpdir(), `front-renamer-${stamp}.patch`);
    const fd = fs.openSync(out, 'w');
    try {
        for (const node of edited) {
            const oldPath = path.relative(engine.project.root, node.initialPath());
            const newPath = path.relative(engine.project.root, node.currentPath());
            let before = '';
            try {
                before = fs.readFileSync(node.initialPath(), 'utf8');
            } catch {
                // Newly synthesised file (no pre-image).
            }
            const after = node.readContent();
            const patch = createPatch(newPath, before, after, oldPath, newPath, {context: 3});
            // `createPatch` already emits "Index: …" + "===" + "--- a/…" + "+++ b/…"
            // headers. Drop the redundant `Index:`/`===` lines so the output is
            // a clean stream of git-style file sections.
            const cleaned = patch.replace(/^Index:.*\n=+\n/m, '');
            fs.writeSync(fd, cleaned);
            if (!cleaned.endsWith('\n')) fs.writeSync(fd, '\n');
        }
    } finally {
        fs.closeSync(fd);
    }
    return out;
}

function printFailureReport(engine: Engine): void {
    const fails = engine.opFailures;
    if (fails.length === 0) return;
    // Group by category (or by first line of the error msg if no category).
    // Each group prints one shared header + one short line per op so the same
    // root cause isn't repeated dozens of times.
    const groups = new Map<string, typeof fails>();
    for (const f of fails) {
        const key = f.category ?? f.error.split('\n')[0];
        const list = groups.get(key) ?? [];
        list.push(f);
        groups.set(key, list);
    }
    console.log(`\n=== ✗ failed ops (${fails.length}, ${groups.size} cause${groups.size > 1 ? 's' : ''}) ===`);
    for (const [key, list] of groups) {
        console.log(`\n  ${describeCategory(key)} — ${list.length} op(s):`);
        const docs = categoryDocsUrl(key);
        if (docs) console.log(`    docs: ${docs}`);
        for (const f of list) {
            const op = f.op as {from?: string; to?: string; extract?: string};
            const symbol = op.extract ? op.extract : 'move';
            const paths = op.from && op.to ? formatFromTo(op.from, op.to) : `${op.from ?? ''} → ${op.to ?? ''}`;
            console.log(`    op#${f.index}  ${symbol}  ${paths}`);
        }
    }
}

/** Single-line human description of a failure category. */
function describeCategory(key: string): string {
    switch (key) {
        case 'ts-ls-internal':
            return 'TS LS internal assertion ("Expected symbol to be a module") — extract these manually';
        case 'ts-ls-no-edits-move-to-file':
            return 'TS LS produced no edits for "Move to file" (target file imports types/aliases) — extract to a distinct file or do manually';
        case 'ts-ls-declined-move-to-new-file':
            return 'TS LS declined "Move to a new file" — symbol must be a top-level export and file must have multiple statements';
        default:
            return key;
    }
}

/** Deep link into the patterns doc — null for unknown categories. */
function categoryDocsUrl(key: string): string | null {
    if (
        key === 'ts-ls-internal' ||
        key === 'ts-ls-no-edits-move-to-file' ||
        key === 'ts-ls-declined-move-to-new-file'
    ) {
        return `https://github.com/cevek/front-renamer/blob/main/docs/ts-ls-failures.md#category-${key}`;
    }
    return null;
}

/**
 * Render the `to` path as a sibling-relative reference when it shares a parent
 * directory with `from` — collapses absurdly long `src/...long.../X → src/...long.../Y`
 * pairs to `src/...long.../X → Y`. Falls back to the project-relative form when
 * the destination is somewhere else.
 */
function shortenTo(from: string, to: string): string {
    const rel = path.relative(path.dirname(from), to);
    if (rel.startsWith('..')) return path.relative(process.cwd(), to);
    return rel;
}

/**
 * Strip the project's source-dir prefix from a project-relative path. Every
 * op operates inside `src/` (or whatever the configured src dir is), so the
 * prefix is pure noise on every line. Held in a module-level mutable cell —
 * `main` sets it once at startup before any path-rendering helper runs.
 */
let srcDirRel = 'src';

function setSrcDirRel(rel: string): void {
    srcDirRel = rel;
}

function stripSrc(p: string): string {
    const prefix = srcDirRel + '/';
    return p.startsWith(prefix) ? p.slice(prefix.length) : p;
}

/**
 * Single rendering of an op's "from → to" pair: strip the `src/` prefix from
 * the source, and render `to` as sibling-relative when possible. Every output
 * site uses this — keep the convention in ONE place.
 *
 * Accepts both project-relative (`op.from`) and absolute (`op.fromAbs`) forms;
 * the latter is only needed for `shortenTo`'s dirname math.
 */
function formatFromTo(from: string, to: string, fromAbs?: string, toAbs?: string): string {
    return `${stripSrc(from)} → ${shortenTo(fromAbs ?? from, toAbs ?? to)}`;
}

function printWarningReport(engine: Engine): void {
    const warns = engine.extractWarnings;
    if (warns.length === 0) return;
    // Group by reason so duplicates (e.g. 5 × "z.object(...) — looks like data")
    // collapse to one header + N ops.
    type Warn = (typeof warns)[number];
    const groups = new Map<string, Warn[]>();
    for (const w of warns) {
        const list = groups.get(w.reason) ?? [];
        list.push(w);
        groups.set(w.reason, list);
    }
    console.log(`\n=== ⚠ warnings (${warns.length}) ===`);
    for (const [reason, list] of groups) {
        console.log(`\n  ${reason} — ${list.length} op(s):`);
        for (const w of list) {
            console.log(`    op#${w.index}  ${w.symbol}  ${formatFromTo(w.from, w.to)}`);
        }
    }
}

/**
 * CSS report is intentionally NOT silenced by --quiet — the README explicitly
 * tells users to read it. Use a separate flag if absolute silence is needed.
 */
function printCssReports(engine: Engine): void {
    const reports = engine.cssReports;
    if (reports.length === 0) return;
    console.log('\n=== CSS co-extract ===');
    for (const r of reports) {
        const src = stripSrc(path.relative(engine.project.root, r.sourceStylesheet));
        const tgt = r.targetStylesheet
            ? stripSrc(path.relative(engine.project.root, r.targetStylesheet))
            : '(none)';
        console.log(`\n  ${src}  →  ${tgt}`);
        if (r.moved.length === 0 && r.leftBehind.length === 0) {
            console.log('    (0 classes referenced by extracted block)');
            continue;
        }
        if (r.moved.length > 0) {
            console.log(`    moved (safe): ${r.moved.map((c) => '.' + c).join(', ')}`);
        }
        if (r.leftBehind.length > 0) {
            console.log('    left behind (manual review):');
            for (const lb of r.leftBehind) {
                console.log(`      .${lb.class}  — ${lb.reason}`);
            }
        }
    }
}

main().catch((err) => {
    // FATAL is the only thing that goes to stderr — separates "process died
    // unexpectedly" from the normal report. Everything else stays on stdout so
    // a single redirect captures the run.
    process.stderr.write(`FATAL: ${(err as Error).message}\n`);
    if (process.env.DEBUG) process.stderr.write((err as Error).stack + '\n');
    process.exit(99);
});
