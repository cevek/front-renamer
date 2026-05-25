/**
 * Import-path rewriter. Operates on the tree-VFS.
 *
 * For each TS/TSX file node:
 *   - Read current content (in-memory if it has overrides, else from initial disk).
 *   - Parse, walk every import/export/dynamic-import.
 *   - Resolve the specifier (relative or alias) to an absolute INITIAL path.
 *   - Look up that node in the tree.
 *   - Emit a NEW specifier from the importer's CURRENT directory to the target's
 *     CURRENT location.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import type {ProjectInfo} from './preflight.js';
import type {FsNode, VFSTree} from './vfs.js';

interface ImportEdit {
    start: number;
    end: number;
    replacement: string;
}

export function rewriteImportsInFile(
    fileNode: FsNode,
    project: ProjectInfo,
    tree: VFSTree,
): {changed: boolean; content: string} {
    const original = fileNode.readContent();
    const sf = ts.createSourceFile(
        fileNode.initialPath(),
        original,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
    );

    const edits: ImportEdit[] = [];
    // Importer's CURRENT directory (post-moves).
    const importerCurrentDir = path.dirname(fileNode.currentPath());
    // Importer's INITIAL directory (for resolving relative specifiers as written).
    const importerInitialDir = path.dirname(fileNode.initialPath());

    const visit = (node: ts.Node) => {
        const moduleSpec = getModuleSpecifier(node);
        if (moduleSpec) {
            const spec = moduleSpec.text;
            const wasAlias = !spec.startsWith('.');
            const resolved = resolveSpecifierToInitialPath(spec, importerInitialDir, project);
            if (resolved) {
                const targetNode = locateTargetNode(resolved, tree);
                if (targetNode) {
                    const targetCurrent = targetNode.currentPath();
                    const newSpec = emitSpecifier(
                        targetCurrent,
                        importerCurrentDir,
                        project,
                        spec,
                        wasAlias,
                        path.extname(resolved),
                    );
                    if (newSpec !== spec) {
                        edits.push({
                            start: moduleSpec.getStart(sf),
                            end: moduleSpec.getEnd(),
                            replacement: JSON.stringify(newSpec),
                        });
                    }
                }
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(sf);

    if (edits.length === 0) return {changed: false, content: original};
    edits.sort((a, b) => b.start - a.start);
    let next = original;
    for (const e of edits) {
        next = next.slice(0, e.start) + e.replacement + next.slice(e.end);
    }
    return {changed: true, content: next};
}

function getModuleSpecifier(node: ts.Node): ts.StringLiteral | null {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) return node.moduleSpecifier;
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier))
        return node.moduleSpecifier;
    if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments.length > 0 &&
        ts.isStringLiteral(node.arguments[0])
    ) {
        return node.arguments[0] as ts.StringLiteral;
    }
    return null;
}

/** Resolve a relative-or-alias specifier to an absolute INITIAL-tree path (no extension assumed). */
function resolveSpecifierToInitialPath(spec: string, importerDir: string, project: ProjectInfo): string | null {
    if (spec.startsWith('.')) {
        return path.resolve(importerDir, spec);
    }
    for (const {aliasPrefix, absPrefix} of project.aliasPrefixes) {
        if (spec === aliasPrefix.slice(0, -1) || spec.startsWith(aliasPrefix)) {
            return path.resolve(absPrefix, spec.slice(aliasPrefix.length));
        }
    }
    return null;
}

/** Find the target node for a resolved import path: try as a file (with various ext), then as a dir. */
function locateTargetNode(resolvedAbs: string, tree: VFSTree): FsNode | null {
    // Already with extension?
    if (/\.(tsx?|jsx?|module\.scss|module\.css|scss|css)$/.test(resolvedAbs)) {
        const direct = tree.findByInitialPath(resolvedAbs);
        if (direct) return direct;
        // For .module.scss not in the project: synthesize a sibling lookup — we can
        // still rewrite the path even if the scss isn't tracked, by walking the parent dir.
        return null;
    }
    for (const ext of ['.tsx', '.ts']) {
        const n = tree.findByInitialPath(resolvedAbs + ext);
        if (n) return n;
    }
    const asDir = tree.findByInitialPath(resolvedAbs);
    if (asDir) return asDir;
    for (const ext of ['.tsx', '.ts']) {
        const idx = tree.findByInitialPath(path.join(resolvedAbs, 'index' + ext));
        if (idx) return idx;
    }
    return null;
}

function emitSpecifier(
    targetCurrent: string,
    importerCurrentDir: string,
    project: ProjectInfo,
    originalSpec: string,
    wasAlias: boolean,
    originalExt: string,
): string {
    // Strip extension if the original spec didn't include one AND the resolved file is a
    // TS/JS module (TS bundler resolution lets you omit `.tsx`/`.ts` but NOT `.json`).
    const includedExt = /\.(tsx?|jsx?|module\.scss|module\.css|scss|css)$/.test(originalSpec);
    const isTsModule = /^\.(tsx?|jsx?)$/.test(originalExt);
    let target = targetCurrent;
    if (!includedExt && isTsModule && target.endsWith(originalExt)) {
        target = target.slice(0, -originalExt.length);
    }

    if (wasAlias) {
        for (const {aliasPrefix, absPrefix} of project.aliasPrefixes) {
            const absNoSlash = absPrefix.slice(0, -1);
            if (target === absNoSlash || target.startsWith(absPrefix)) {
                const rel = path.relative(absPrefix, target).split(path.sep).join('/');
                return aliasPrefix + rel;
            }
        }
    }
    let rel = path.relative(importerCurrentDir, target).split(path.sep).join('/');
    if (!rel.startsWith('.')) rel = './' + rel;
    return rel;
}

// (Unused export retained for backward signature in case other modules import directly.)
export function _existsSync(p: string): boolean {
    try {
        fs.statSync(p);
        return true;
    } catch {
        return false;
    }
}
