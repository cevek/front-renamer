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
        node.parent = this;
        this.childrenByInitial.set(node.initialName, node);
        this.childrenByCurrent.set(node.currentName, node);
    }

    removeChild(node: FsNode): void {
        this.childrenByInitial.delete(node.initialName);
        this.childrenByCurrent.delete(node.currentName);
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
        if (!this.parent) return this.currentName;
        return path.join(this.parent.currentPath(), this.currentName);
    }

    /** Path the node *was at* when the tree was built. Stable across moves/renames. */
    initialPath(): string {
        return this._initialAbs || this.initialName;
    }

    /** Rename this node (change its name only; parent stays). */
    rename(newName: string): void {
        if (this.parent) {
            this.parent.childrenByCurrent.delete(this.currentName);
        }
        this.currentName = newName;
        if (this.parent) {
            // Future safeguard against collision.
            if (this.parent.childrenByCurrent.has(newName)) {
                throw new Error(
                    `name collision in ${this.parent.currentPath()}: ${newName} already exists`,
                );
            }
            this.parent.childrenByCurrent.set(newName, this);
        }
    }

    /** Move this node under a new parent (optionally with a new name). */
    moveTo(newParent: FsNode, newName?: string): void {
        if (newParent.kind !== 'dir') throw new Error('moveTo: new parent must be a dir');
        if (this.parent) this.parent.removeChild(this);
        if (newName !== undefined) this.currentName = newName;
        // Skip the rename collision check here — addChild does it implicitly via Map.set
        // but a stricter check would be added if needed.
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
