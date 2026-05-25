/**
 * Tree-based virtual file system.
 *
 * Every directory and file under the project root is a `Node`. A node remembers:
 *   - its `initialName` (immutable, as it existed when the tree was built)
 *   - its `currentName` (mutable, after renames)
 *   - its `parent` reference (mutable, after moves)
 *
 * Mutations:
 *   - `rename(name)` changes `currentName` only
 *   - `moveTo(newParent, optionalNewName)` re-parents the node
 *
 * Lookups go through the tree, NOT a flat path map. That kills entire classes
 * of bugs around chained renames: when grandparent moves, all descendants
 * follow automatically; when sibling is added by another op, lookups by initial
 * path still find the moved node.
 *
 * Resolution:
 *   - `findByInitialPath(initialAbs)` → node (walk tree by initial names)
 *   - `findByCurrentPath(currentAbs)` → node (walk tree by current names)
 *   - `node.currentPath()` → absolute path under the tree's current layout
 *   - `node.initialPath()` → absolute path under the original layout
 *
 * Plus: nodes can carry in-memory content edits (e.g. after identifier rename
 * or import rewrite). Content is keyed by node identity, not path, so it
 * survives moves and renames automatically.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export type NodeKind = 'dir' | 'file';

export class FsNode {
    parent: FsNode | null;
    initialName: string;
    currentName: string;
    readonly kind: NodeKind;
    /** Snapshot of the absolute path AT BUILD TIME. Immutable — survives moves/renames. */
    private _initialAbs: string = '';
    /** Children indexed by INITIAL name (immutable identity). */
    private readonly childrenByInitial = new Map<string, FsNode>();
    /** Children indexed by CURRENT name (updated on rename/move). */
    private readonly childrenByCurrent = new Map<string, FsNode>();
    /** In-memory content override (set by identifier rename / import rewrite). null = "use original on disk". */
    private content: string | null = null;

    /** Parent reference AT BUILD TIME — stays even after the node is moved. */
    readonly initialParent: FsNode | null;

    constructor(name: string, kind: NodeKind, parent: FsNode | null) {
        this.initialName = name;
        this.currentName = name;
        this.kind = kind;
        this.parent = parent;
        this.initialParent = parent;
    }

    /** Called by the tree builder once parent linkage is final. */
    captureInitialPath(p: string): void {
        this._initialAbs = p;
    }

    addChild(node: FsNode): void {
        if (this.kind !== 'dir') throw new Error(`addChild on non-dir: ${this.currentPath()}`);
        // Hard collision check on the active key. Initial-name overlap is allowed
        // only when the existing entry is the node itself (idempotent add).
        const colliding = this.childrenByCurrent.get(node.currentName);
        if (colliding && colliding !== node) {
            throw new Error(
                `addChild: name collision in ${this.currentPath()}: ${node.currentName} already exists`,
            );
        }
        node.parent = this;
        // Only register the initial-name key if it doesn't already point at something else
        // — protects against silent overwrites when synthetic nodes share an initialName
        // with a sibling that was removed-then-re-added.
        if (!this.childrenByInitial.has(node.initialName)) {
            this.childrenByInitial.set(node.initialName, node);
        }
        this.childrenByCurrent.set(node.currentName, node);
    }

    removeChild(node: FsNode): void {
        // Guard against blind name-based deletion: only remove map entries that
        // ACTUALLY point at this node, so we never evict a sibling that re-used
        // the same key.
        if (this.childrenByInitial.get(node.initialName) === node) {
            this.childrenByInitial.delete(node.initialName);
        }
        if (this.childrenByCurrent.get(node.currentName) === node) {
            this.childrenByCurrent.delete(node.currentName);
        }
    }

    childByInitial(name: string): FsNode | undefined {
        return this.childrenByInitial.get(name);
    }
    childByCurrent(name: string): FsNode | undefined {
        return this.childrenByCurrent.get(name);
    }

    *iterChildren(): IterableIterator<FsNode> {
        yield* this.childrenByInitial.values();
    }

    /** Path the node currently *lives at* (walks parents using current names). */
    currentPath(): string {
        // Iterative to avoid stack overflow on pathological trees / accidental
        // self-cycles caught by moveTo's guard.
        const segments: string[] = [];
        let cur: FsNode | null = this;
        const seen = new Set<FsNode>();
        while (cur) {
            if (seen.has(cur)) {
                throw new Error(`currentPath: cycle detected at ${cur.currentName}`);
            }
            seen.add(cur);
            if (!cur.parent) {
                segments.push(cur.currentName);
                break;
            }
            segments.push(cur.currentName);
            cur = cur.parent;
        }
        segments.reverse();
        return segments.length === 1 ? segments[0] : path.join(...segments);
    }

    /** Path the node *was at* when the tree was built. Stable across moves/renames. */
    initialPath(): string {
        return this._initialAbs || this.initialName;
    }

    /** Rename this node (change its name only; parent stays). */
    rename(newName: string): void {
        if (newName === this.currentName) return;
        if (this.parent) {
            // Collision check FIRST — never mutate state on a failure path.
            const colliding = this.parent.childrenByCurrent.get(newName);
            if (colliding && colliding !== this) {
                throw new Error(
                    `name collision in ${this.parent.currentPath()}: ${newName} already exists`,
                );
            }
            if (this.parent.childrenByCurrent.get(this.currentName) === this) {
                this.parent.childrenByCurrent.delete(this.currentName);
            }
        }
        this.currentName = newName;
        if (this.parent) {
            this.parent.childrenByCurrent.set(newName, this);
        }
    }

    /** Move this node under a new parent (optionally with a new name). */
    moveTo(newParent: FsNode, newName?: string): void {
        if (newParent.kind !== 'dir') throw new Error('moveTo: new parent must be a dir');
        // Cycle guard: can't move a node into itself or one of its own descendants.
        let walker: FsNode | null = newParent;
        while (walker) {
            if (walker === this) {
                throw new Error(`moveTo: cannot move ${this.currentName} into its own subtree`);
            }
            walker = walker.parent;
        }
        const targetName = newName ?? this.currentName;
        // Skip the work when moveTo is a no-op (same parent + same name).
        if (this.parent === newParent && targetName === this.currentName) return;
        // Collision check FIRST.
        const colliding = newParent.childrenByCurrent.get(targetName);
        if (colliding && colliding !== this) {
            throw new Error(
                `moveTo: name collision in ${newParent.currentPath()}: ${targetName} already exists`,
            );
        }
        if (this.parent) this.parent.removeChild(this);
        if (newName !== undefined) this.currentName = newName;
        newParent.addChild(this);
        this.parent = newParent;
    }

    setContent(content: string): void {
        this.content = content;
    }

    /** Read content: in-memory edit if present, else read from disk at initial path. */
    readContent(): string {
        if (this.content !== null) return this.content;
        return fs.readFileSync(this.initialPath(), 'utf8');
    }

    hasContentOverride(): boolean {
        return this.content !== null;
    }
}

export class VFSTree {
    readonly root: FsNode;
    /** All nodes, indexed for fast lookup by initial absolute path. */
    private readonly byInitialPath = new Map<string, FsNode>();

    constructor(public readonly projectRoot: string) {
        this.root = new FsNode(projectRoot, 'dir', null);
        this.root.captureInitialPath(projectRoot);
        this.byInitialPath.set(projectRoot, this.root);
    }

    /** Build the tree by scanning the disk under `srcDir`. */
    static build(projectRoot: string, srcDir: string): VFSTree {
        const tree = new VFSTree(projectRoot);
        let parent = tree.root;
        const srcRel = path.relative(projectRoot, srcDir);
        for (const segment of srcRel.split(path.sep)) {
            const child = new FsNode(segment, 'dir', parent);
            parent.addChild(child);
            child.captureInitialPath(path.join(parent.initialPath(), segment));
            tree.byInitialPath.set(child.initialPath(), child);
            parent = child;
        }

        const walk = (parent: FsNode, dir: string) => {
            for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
                const isDir = entry.isDirectory();
                const child = new FsNode(entry.name, isDir ? 'dir' : 'file', parent);
                parent.addChild(child);
                child.captureInitialPath(path.join(parent.initialPath(), entry.name));
                tree.byInitialPath.set(child.initialPath(), child);
                if (isDir) walk(child, path.join(dir, entry.name));
            }
        };
        walk(parent, srcDir);
        return tree;
    }

    /** Look up node by its original on-disk absolute path (the path it had at build time). */
    findByInitialPath(initialAbs: string): FsNode | null {
        return this.byInitialPath.get(initialAbs) ?? null;
    }

    /** Look up node by following current names from root. */
    findByCurrentPath(currentAbs: string): FsNode | null {
        if (currentAbs === this.projectRoot) return this.root;
        const rel = path.relative(this.projectRoot, currentAbs);
        if (rel.startsWith('..')) return null;
        const segments = rel.split(path.sep);
        let cur: FsNode | null = this.root;
        for (const seg of segments) {
            if (!cur) return null;
            const next: FsNode | undefined = cur.childByCurrent(seg);
            if (!next) return null;
            cur = next;
        }
        return cur;
    }

    /**
     * Create a NEW file node under `parent`. Used for files that didn't exist
     * on disk at scan time (e.g. produced by an extract op). The node's
     * `initialPath()` is set to its current path; commit() detects "no disk
     * presence at initialPath" and writes the file fresh rather than git-mv.
     */
    addFileAtCurrent(parent: FsNode, name: string, content: string): FsNode {
        if (parent.kind !== 'dir') throw new Error('addFileAtCurrent: parent must be a dir');
        if (parent.childByCurrent(name)) {
            throw new Error(`file already exists at: ${path.join(parent.currentPath(), name)}`);
        }
        const node = new FsNode(name, 'file', parent);
        parent.addChild(node);
        const synthPath = path.join(parent.currentPath(), name);
        node.captureInitialPath(synthPath);
        node.setContent(content);
        // Register under its synthetic initial path so importers that reference the
        // new file by its TS-LS-chosen name (before our re-target move) can still
        // be resolved by `findByInitialPath`.
        this.byInitialPath.set(synthPath, node);
        return node;
    }

    /**
     * Make a synthetic node findable by an ADDITIONAL key in `byInitialPath`,
     * without changing the node's own `_initialAbs`. Why: relative imports in
     * the node's CONTENT were emitted by TS LS anchored at the LS-chosen path
     * (the original `_initialAbs`). Touching `_initialAbs` here would shift
     * `imports.ts`'s anchor and break resolution for every `./relative` spec
     * in the extracted file. We KEEP `_initialAbs` at the LS-chosen path so
     * relative-import resolution remains correct, while the map carries an
     * extra entry for the FINAL path so external lookups (`findByInitialPath
     * (op.toAbs)`) succeed.
     */
    rekeyByInitialPath(node: FsNode, _oldKey: string, newKey: string): void {
        this.byInitialPath.set(newKey, node);
    }

    /** Ensure a directory chain exists at the given current path (creates synthetic dir nodes). */
    ensureDirAtCurrent(currentAbs: string): FsNode {
        if (currentAbs === this.projectRoot) return this.root;
        const rel = path.relative(this.projectRoot, currentAbs);
        const segments = rel.split(path.sep);
        let cur: FsNode = this.root;
        for (const seg of segments) {
            let next = cur.childByCurrent(seg);
            if (!next) {
                next = new FsNode(seg, 'dir', cur);
                cur.addChild(next);
                // Synthetic dir: its "initialPath" is its current path, since nothing was at this
                // disk location before. Mark it as such so callers can distinguish if needed.
                next.captureInitialPath(path.join(cur.currentPath(), seg));
            }
            cur = next;
        }
        return cur;
    }

    /** Iterate every file node (depth-first). */
    *iterFiles(): IterableIterator<FsNode> {
        const stack: FsNode[] = [this.root];
        while (stack.length) {
            const node = stack.pop()!;
            for (const child of node.iterChildren()) {
                if (child.kind === 'file') yield child;
                else stack.push(child);
            }
        }
    }

    /** Iterate every dir node (depth-first). */
    *iterDirs(): IterableIterator<FsNode> {
        const stack: FsNode[] = [this.root];
        while (stack.length) {
            const node = stack.pop()!;
            yield node;
            for (const child of node.iterChildren()) {
                if (child.kind === 'dir') stack.push(child);
            }
        }
    }
}
