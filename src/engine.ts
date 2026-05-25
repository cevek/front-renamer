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
import {ExtractEngine} from './extract.js';

export class Engine {
    readonly tree: VFSTree;
    readonly renames: RenameEngine;

    constructor(public readonly project: ProjectInfo) {
        this.tree = VFSTree.build(project.root, path.join(project.root, 'src'));
        this.renames = new RenameEngine(project, this.tree);
    }

    /** Cache: op.index → declaring file node (set during Phase 1 application). */
    private declNodes = new Map<number, FsNode>();

    /** Apply every level in order to the tree. No disk writes yet. */
    applyToVFS(levels: PlanLevel[]): void {
        // ---- Tree mutations honour the plan DAG: one pass per level, dispatching
        // by op kind. Extracts and moves can be interleaved across levels (e.g.
        // a move that produces a file the next level's extract reads from). ----
        for (const lvl of levels) {
            for (const op of lvl.ops) {
                if (op.kind === 'extract') this.applyExtract(op);
                else this.applyMoveToTree(op);
            }
        }

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
                    this.renames.rename(declNode, sym.old, sym.new);
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

    /** Reports from CSS co-extraction (for output). */
    get cssReports(): ReadonlyArray<import('./extract-css.js').CssCoExtractReport> {
        return this.extracts?.cssReports ?? [];
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
                const first = op.renameSymbols[0];
                for (const ext of ['.tsx', '.ts', '.module.scss', '.module.css']) {
                    const child = node.childByCurrent(first.old + ext);
                    if (child) {
                        child.rename(first.new + ext);
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
            try {
                execFileSync('git', ['mv', '-k', from, to], {cwd: root, stdio: 'pipe'});
                moved.add(node);
            } catch (gitErr) {
                try {
                    fs.renameSync(from, to);
                    moved.add(node);
                } catch (fsErr) {
                    process.stderr.write(
                        `  ✗ failed to move ${from} → ${to}: ${(fsErr as Error).message}\n` +
                            `    (git mv error: ${(gitErr as Error).message})\n`,
                    );
                    throw fsErr;
                }
            }
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
