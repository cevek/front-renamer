/**
 * Engine: orchestrates ops over a tree-VFS.
 *
 * Flow:
 *   1. Build the tree from disk.
 *   2. For every op (in plan order): mutate the tree (rename / moveTo).
 *      Folder ops with renameSymbol also rename the main `<oldName>.tsx`
 *      child and its sibling `.module.scss` to follow the new symbol name.
 *   3. Run identifier renames via TS language service (reads from initial-path
 *      on disk, writes back to node content).
 *   4. Rewrite imports across every file (reads/writes node content).
 *   5. commit() walks the tree depth-first and applies `git mv` for nodes
 *      whose currentPath differs from initialPath, then writes content overrides.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {execFileSync} from 'node:child_process';
import type {PlanLevel} from './schema.js';
import type {ProjectInfo} from './preflight.js';
import {VFSTree, type FsNode} from './vfs.js';
import {RenameEngine} from './rename.js';
import {rewriteImportsInFile} from './imports.js';
import {DeferredExtract, ExtractEngine, ExtractFailure} from './extract.js';

export class Engine {
    readonly tree: VFSTree;
    readonly renames: RenameEngine;

    constructor(public readonly project: ProjectInfo) {
        this.tree = VFSTree.build(project.root, path.join(project.root, 'src'));
        this.renames = new RenameEngine(project, this.tree);
    }

    /** Cache: op.index → declaring file node (set during Phase 1 application). */
    private declNodes = new Map<number, FsNode>();

    /** Whether to keep going when a single op fails (default: false = fail-fast). */
    continueOnError = false;

    /**
     * Per-op failures captured during applyToVFS when continueOnError is on.
     * `category` groups duplicates so the CLI can emit one shared header + a
     * single-line entry per op instead of repeating the same root cause.
     */
    readonly opFailures: Array<{
        index: number;
        op: unknown;
        error: string;
        category: string | null;
        context: string | null;
    }> = [];

    /**
     * Ops that completed successfully. Lets the dry-run summary report what
     * the batch actually accomplished — split by kind — instead of inferring
     * from tree state (which conflates extract-created files with file moves).
     */
    readonly appliedOps: Array<import('./schema.js').NormalizedOp> = [];

    /** Apply every level in order to the tree. No disk writes yet. */
    applyToVFS(levels: PlanLevel[]): void {
        // ---- Tree mutations honour the plan DAG: one pass per level, dispatching
        // by op kind. Extracts and moves can be interleaved across levels (e.g.
        // a move that produces a file the next level's extract reads from). ----
        for (const lvl of levels) {
            for (const op of lvl.ops) {
                try {
                    if (op.kind === 'extract') this.applyExtract(op);
                    else this.applyMoveToTree(op);
                    this.appliedOps.push(op);
                } catch (err) {
                    // Deferred extract — neither success nor failure yet.
                    // The op is parked in ExtractEngine.pendingFallback and
                    // will be retried in `flushPendingFallback` at the end of
                    // this method. Don't push to appliedOps OR opFailures.
                    if (err instanceof DeferredExtract) continue;
                    // Always record the failure with structured metadata so
                    // the CLI's `printFailureReport` renders it through the
                    // same grouped path it uses for continue-mode batches.
                    // In strict mode we ALSO rethrow to abort — but the entry
                    // is already in `opFailures`, so the catch site can run
                    // the report instead of dumping a raw Error.message.
                    const e = err as Error;
                    const structured = err instanceof ExtractFailure ? err : null;
                    this.opFailures.push({
                        index: op.index,
                        op,
                        error: e.message ?? String(err),
                        category: structured?.category ?? null,
                        context: structured?.context ?? null,
                    });
                    if (!this.continueOnError) throw err;
                }
            }
        }

        // Batched fallback pass — all ops that hit the stock LS' assertion
        // get one consolidated run through the patched LS here. Done after
        // the main loop completes so the patched LS' program is synced once
        // against the final stock-LS-modified VFS (O(N) sync) instead of
        // catching up on every interleaved stock-LS edit (O(N×M)).
        this.extracts?.flushPendingFallback({
            onApplied: (op) => this.appliedOps.push(op),
            onFailed: (op, category, context) => {
                this.opFailures.push({
                    index: op.index,
                    op,
                    error: `[${category}] op#${op.index} ${op.extract}: ${context}`,
                    category,
                    context,
                });
            },
        });

        // ---- Identifier renames run after all tree mutations: they're driven
        // through the TS language service and don't care about physical layout. ----
        for (const lvl of levels) {
            for (const op of lvl.ops) {
                if (op.kind !== 'move' || op.renameSymbols.length === 0) continue;
                const declNode = this.declNodes.get(op.index);
                if (!declNode) {
                    const names = op.renameSymbols.map((r) => r.old).join(', ');
                    process.stderr.write(
                        `  ⚠ op#${op.index}: declaring file not found for symbol(s) ${names}\n`,
                    );
                    continue;
                }
                for (const sym of op.renameSymbols) {
                    try {
                        this.renames.rename(declNode, sym.old, sym.new);
                    } catch (err) {
                        // Record BEFORE rethrow, same as the main op loop —
                        // gives the strict-mode catch site a structured entry
                        // to format instead of a raw Error message.
                        this.opFailures.push({
                            index: op.index,
                            op,
                            error: `rename ${sym.old}→${sym.new}: ${(err as Error).message}`,
                            category: null,
                            context: null,
                        });
                        if (!this.continueOnError) throw err;
                    }
                }
            }
        }
    }

    /** TS LS "Move to a new file" → place the resulting file at op.to. */
    private applyExtract(op: import('./schema.js').NormalizedExtractOp): void {
        if (!this.extracts) {
            this.extracts = new ExtractEngine(this.project, this.tree, this.renames);
        }
        this.extracts.extract(op);
    }

    private extracts: ExtractEngine | null = null;

    /** Delete any disk stubs the extract phase wrote (dry-run cleanup). */
    cleanupExtractStubs(): void {
        this.extracts?.cleanupDiskStubs();
    }

    /** Run the post-process sweep over every file that was edited by extract. */
    postProcessExtractTouched(): void {
        this.extracts?.postProcessAllTouched();
    }

    /**
     * Patch consumer imports that the TS LS couldn't reach — typically files
     * created by earlier extract ops in this batch (LS only updates consumers
     * already in its program).
     */
    rewriteExtractSymbolConsumers(): void {
        this.extracts?.rewriteSymbolConsumers();
    }

    /** Reports from CSS co-extraction (for output). */
    get cssReports(): ReadonlyArray<import('./extract-css.js').CssCoExtractReport> {
        return this.extracts?.cssReports ?? [];
    }

    /**
     * How many ops the patched-TS fallback rescued. 0 when the package isn't
     * installed OR no op tripped the assertion.
     */
    get rescuedByFallback(): number {
        return this.extracts?.rescuedByFallback ?? 0;
    }

    /**
     * Run prettier across every file the batch touched (content overrides or
     * relocations) — keeps the diff small AND consistent with the project's
     * own style. Returns a count of files formatted; skipped files (ignored or
     * unsupported extension) don't count.
     *
     * Caller decides whether prettier is available; we just take the formatter.
     */
    async formatTouchedFiles(
        formatter: (absolutePath: string, content: string) => Promise<string | null>,
    ): Promise<{formatted: number; skipped: number; failed: Array<{path: string; reason: string}>}> {
        let formatted = 0;
        let skipped = 0;
        const failed: Array<{path: string; reason: string}> = [];
        for (const node of this.tree.iterFiles()) {
            const touched = node.hasContentOverride() || node.currentPath() !== node.initialPath();
            if (!touched) continue;
            const abs = node.currentPath();
            const before = node.readContent();
            // Per-file try/catch — a single broken `.prettierrc` override (bad
            // parser, unknown option, syntax error in the file) MUST NOT kill
            // the batch. We record it and move on. The user still gets the
            // touched-file written; just not formatted.
            let after: string | null;
            try {
                after = await formatter(abs, before);
            } catch (err) {
                failed.push({path: abs, reason: (err as Error).message});
                continue;
            }
            if (after === null) {
                skipped++;
                continue;
            }
            if (after !== before) node.setContent(after);
            formatted++;
        }
        return {formatted, skipped, failed};
    }

    /**
     * Snapshot of every file the batch touched, suitable for VFS-aware
     * typecheck in dry mode. Each entry carries:
     *   - `path` — where the file lives AFTER the batch
     *   - `content` — post-batch source
     *   - `initialPath` — where it was BEFORE; used by the typecheck host to
     *     mark the old location as gone so stale-import diagnostics fire.
     *
     * We include every file with either a content override or a relocation —
     * skipping unchanged files keeps the overlay focused (TS reads disk for
     * the rest, which is faster than rebuilding source-files from strings).
     */
    collectTypecheckOverlay(): Array<{path: string; content: string; initialPath?: string}> {
        const out: Array<{path: string; content: string; initialPath?: string}> = [];
        for (const node of this.tree.iterFiles()) {
            const moved = node.currentPath() !== node.initialPath();
            const edited = node.hasContentOverride();
            if (!moved && !edited) continue;
            // Only TS/JS modules belong in the typecheck program. CSS module
            // co-extract edits sibling `.module.scss` files; including those
            // in the overlay drags them into the root file list and TS rejects
            // them with TS6054 ("unsupported extension"). Asset-style files
            // (CSS / images / JSON) participate in the build via import
            // resolution at the consumer site, not as standalone roots.
            if (!/\.(tsx?|jsx?|d\.ts|d\.mts|d\.cts|mts|cts)$/i.test(node.currentName)) continue;
            out.push({
                path: node.currentPath(),
                content: node.readContent(),
                initialPath: moved ? node.initialPath() : undefined,
            });
        }
        return out;
    }

    /** Deferred warnings (suspicious extracts, CSS co-extract sub-failures, …). */
    get extractWarnings(): ReadonlyArray<{
        index: number;
        symbol: string;
        from: string;
        to: string;
        reason: string;
    }> {
        return this.extracts?.warnings ?? [];
    }

    /** Tree-side application of a single MOVE op. */
    private applyMoveToTree(op: import('./schema.js').NormalizedMoveOp): void {
        const node = this.tree.findByCurrentPath(op.fromAbs);
        if (!node) {
            console.warn(`  ⚠ op#${op.index}: source not found in tree: ${op.from}`);
            return;
        }

        const newParent = this.tree.ensureDirAtCurrent(path.dirname(op.toAbs));
        const newName = path.basename(op.toAbs);
        node.moveTo(newParent, newName);

        if (!op.isFolder && /\.(tsx?|jsx?)$/.test(node.initialName) && node.initialParent) {
            const initBase = node.initialName.replace(/\.(tsx?|jsx?)$/, '');
            const newBase = path.basename(op.toAbs, path.extname(op.toAbs));
            for (const ext of ['.module.scss', '.module.css']) {
                const sibling = node.initialParent.childByCurrent(initBase + ext);
                if (sibling) sibling.moveTo(newParent, newBase + ext);
            }
        }

        if (op.renameSymbols.length > 0) {
            if (!op.isFolder) {
                this.declNodes.set(op.index, node);
            } else {
                // Folder op with renameSymbols — rename EVERY matching child
                // pair (`Old.tsx` → `New.tsx` + same for `.ts`/`.module.scss`
                // /`.module.css`) for EVERY {old, new} entry. Previously we
                // only honoured `renameSymbols[0]`, so a folder op with
                // multiple renames left files for symbols 2..N on disk under
                // old names while their content was already rewritten — broken
                // imports across the project.
                //
                // The FIRST `.tsx`/`.ts` child we rename becomes the decl-node
                // anchor for the subsequent identifier-rename pass — that
                // matches the historical behaviour and keeps `declNodes`
                // consistent (one anchor per op).
                for (const sym of op.renameSymbols) {
                    for (const ext of ['.tsx', '.ts', '.module.scss', '.module.css']) {
                        const child = node.childByCurrent(sym.old + ext);
                        if (!child) continue;
                        child.rename(sym.new + ext);
                        if ((ext === '.tsx' || ext === '.ts') && !this.declNodes.has(op.index)) {
                            this.declNodes.set(op.index, child);
                        }
                    }
                }
            }
        }
    }

    /** Rewrite imports across every file in the project. */
    rewriteAllImports(): {filesChanged: number} {
        let filesChanged = 0;
        for (const node of this.tree.iterFiles()) {
            if (!/\.(ts|tsx)$/.test(node.currentName)) continue;
            const {changed, content} = rewriteImportsInFile(node, this.project, this.tree);
            if (changed) {
                node.setContent(content);
                filesChanged++;
            }
        }
        return {filesChanged};
    }

    summarize(): string {
        let moves = 0;
        let edits = 0;
        for (const node of this.tree.iterFiles()) {
            if (node.currentPath() !== node.initialPath()) moves++;
            if (node.hasContentOverride()) edits++;
        }
        for (const node of this.tree.iterDirs()) {
            if (node !== this.tree.root && node.currentPath() !== node.initialPath()) moves++;
        }
        return `tree: ${moves} node(s) relocated, ${edits} file(s) edited`;
    }

    /** Commit: depth-first git mv + writeFile. */
    commit(): void {
        const root = this.project.root;

        // Collect every node that physically needs to move.
        // We do this in TWO passes:
        //   1. Write content overrides to INITIAL paths (so the files are up to date)
        //      then perform git mv from initial to current. — but git mv preserves
        //      content as it is on disk, so we want content written AFTER the move.
        //   Actually simpler: git mv first (preserves history), then writeFile to
        //   currentPath. That way the file is at its new location, then we overlay
        //   the new content.

        // Folder moves go first (children follow), but if a child has been renamed
        // INSIDE its folder, we need to do those too. Easiest: sort by initialPath
        // length ASCENDING so parents move first → children inherit, then file
        // renames inside the moved folder.

        const movers: FsNode[] = [];
        // New files (synthetic, no disk presence at initialPath) are handled separately below
        // via writeFile — they're not moves.
        const newFiles: FsNode[] = [];
        for (const node of this.tree.iterDirs()) {
            if (node === this.tree.root) continue;
            if (node.currentPath() !== node.initialPath()) movers.push(node);
        }
        for (const node of this.tree.iterFiles()) {
            if (!fs.existsSync(node.initialPath())) {
                newFiles.push(node);
                continue;
            }
            if (node.currentPath() !== node.initialPath()) movers.push(node);
        }

        // A child's relocation is "explained" by an ancestor move when:
        //   - the child still lives under its INITIAL parent (parent ref unchanged), AND
        //   - the child's name didn't change.
        // In that case the ancestor's git-mv carries the child along automatically.
        const moversSet = new Set(movers);
        const explainedBy = (n: FsNode): boolean => {
            if (n.parent !== n.initialParent) return false; // child moved to a new parent
            if (n.currentName !== n.initialName) return false; // child got renamed
            // Walk initialParent chain to find a mover.
            let p: FsNode | null = n.initialParent;
            while (p) {
                if (moversSet.has(p)) return true;
                if (p.parent !== p.initialParent) return false; // an ancestor moved away — can't inherit
                p = p.initialParent;
            }
            return false;
        };

        const explicitMoves = movers.filter((n) => !explainedBy(n));
        // Sort: directories first (shorter path), files second. Within each, by depth ascending.
        explicitMoves.sort((a, b) => {
            const dirA = a.kind === 'dir' ? 0 : 1;
            const dirB = b.kind === 'dir' ? 0 : 1;
            if (dirA !== dirB) return dirA - dirB;
            return a.initialPath().length - b.initialPath().length;
        });

        // Track which nodes have already been physically moved on disk. The on-disk
        // location of any descendant is computed off the closest moved ancestor.
        const moved = new Set<FsNode>();
        const actualOnDiskPath = (node: FsNode): string => {
            // Walk the initial-parent chain looking for the nearest moved ancestor.
            const trail: string[] = [];
            let cursor: FsNode | null = node;
            while (cursor && cursor.initialParent) {
                if (moved.has(cursor.initialParent)) {
                    // ancestor.currentPath() / cursor.initialName / [trail reversed]
                    // cursor is the immediate child of the moved ancestor; trail accumulated
                    // names innermost-first while walking up, so reverse to descend.
                    return path.join(cursor.initialParent.currentPath(), cursor.initialName, ...trail.reverse());
                }
                trail.push(cursor.initialName);
                cursor = cursor.initialParent;
            }
            return node.initialPath();
        };

        for (const node of explicitMoves) {
            const from = actualOnDiskPath(node);
            const to = node.currentPath();
            if (from === to) continue;
            fs.mkdirSync(path.dirname(to), {recursive: true});
            // No `-k` — under `-k`, git silently skips moves it can't perform
            // (source gitignored, target collision, etc.) and we'd treat the
            // op as successful, leaving the source on disk. Then the later
            // `writeFileSync(target, …)` pass would write the post-move
            // content to the new path → file effectively duplicated. Without
            // `-k` git errors out, and our fallback to `fs.renameSync` is the
            // ONLY non-git fallback we accept.
            try {
                execFileSync('git', ['mv', from, to], {cwd: root, stdio: 'pipe'});
            } catch (gitErr) {
                try {
                    fs.renameSync(from, to);
                } catch (fsErr) {
                    process.stderr.write(
                        `  ✗ failed to move ${from} → ${to}: ${(fsErr as Error).message}\n` +
                            `    (git mv error: ${(gitErr as Error).message})\n`,
                    );
                    throw fsErr;
                }
            }
            // Belt-and-braces: post-condition check. Catches the rare case
            // where the move "succeeded" per the tool's exit code but the
            // source is still there (e.g. case-insensitive FS rename to
            // same-case-different path, symlink shenanigans).
            if (fs.existsSync(from) && from !== to) {
                throw new Error(
                    `move post-condition failed: source still exists at ${from} after mv to ${to}`,
                );
            }
            moved.add(node);
        }

        // Write brand-new files (produced by extract / similar) to disk.
        for (const node of newFiles) {
            const target = node.currentPath();
            fs.mkdirSync(path.dirname(target), {recursive: true});
            fs.writeFileSync(target, node.readContent());
        }

        // Now overlay content edits at the new (current) paths.
        for (const node of this.tree.iterFiles()) {
            if (!node.hasContentOverride()) continue;
            if (newFiles.includes(node)) continue; // already written above
            const target = node.currentPath();
            fs.writeFileSync(target, node.readContent());
        }

        // Cleanup: recursive walk of the source tree to remove any directory
        // that ended up empty after the moves (covers deep subdirs that were
        // never explicitly named in any op).
        if (this.pruneEmptyDirs) {
            this.removeEmptyDirsRecursive(this.project.srcDir);
        }
    }

    /** Whether to recursively delete empty directories after commit. Defaults to true. */
    pruneEmptyDirs = true;

    private static readonly PRUNE_SKIP = new Set([
        'node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out', 'coverage', '.next', '.turbo', '.cache',
    ]);

    private removeEmptyDirsRecursive(dir: string): boolean {
        if (!fs.existsSync(dir)) return false;
        const entries = fs.readdirSync(dir, {withFileTypes: true});
        let allChildrenRemoved = true;
        for (const entry of entries) {
            if (Engine.PRUNE_SKIP.has(entry.name)) {
                allChildrenRemoved = false;
                continue;
            }
            const child = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                const removed = this.removeEmptyDirsRecursive(child);
                if (!removed) allChildrenRemoved = false;
            } else {
                allChildrenRemoved = false;
            }
        }
        if (allChildrenRemoved && dir !== this.project.srcDir) {
            try {
                fs.rmdirSync(dir);
                return true;
            } catch {
                return false;
            }
        }
        return false;
    }
}
