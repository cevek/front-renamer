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
import {ts} from './ts-loader.js';
import type {ProjectInfo} from './preflight.js';
import type {FsNode, VFSTree} from './vfs.js';
import {applyEdits, emitQuoted} from './text-edits.js';
import {moduleCandidates, resolveSpecifierBase, toRelativeImportSpec} from './module-resolve.js';

// Edit shape comes from `./text-edits.ts` — `TextEdit` uses `text` (not
// `replacement`); keeps the rewrite path coherent with the rest of the tool.
type ImportEdit = {start: number; end: number; text: string};

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
                    // Use the ACTUAL extension of the resolved target file. `path.extname(resolved)`
                    // is empty when the specifier omits the extension (e.g. `./shared` → resolves
                    // to `shared.tsx`), which used to leave `.tsx` in the emitted specifier.
                    const targetExt = path.extname(targetNode.initialName);
                    const newSpec = emitSpecifier(
                        targetCurrent,
                        importerCurrentDir,
                        project,
                        spec,
                        wasAlias,
                        targetExt,
                    );
                    if (newSpec !== spec) {
                        const start = moduleSpec.getStart(sf);
                        edits.push({
                            start,
                            end: moduleSpec.getEnd(),
                            text: emitQuoted(original, start, newSpec),
                        });
                    }
                }
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(sf);

    if (edits.length === 0) return {changed: false, content: original};
    return {changed: true, content: applyEdits(original, edits)};
}

export function getModuleSpecifier(node: ts.Node): ts.StringLiteral | null {
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

/** Thin alias — keeps the old name as a stable API; delegates to the shared helper. */
export function resolveSpecifierToInitialPath(spec: string, importerDir: string, project: ProjectInfo): string | null {
    return resolveSpecifierBase(spec, importerDir, project);
}

/** Find the target node for a resolved import path: try as a file (with various ext), then as a dir. */
export function locateTargetNode(resolvedAbs: string, tree: VFSTree): FsNode | null {
    // CSS-Modules / plain CSS stay as exact-path lookups — they don't participate
    // in `MODULE_EXTENSIONS` probing.
    if (/\.(module\.scss|module\.css|scss|css)$/.test(resolvedAbs)) {
        return tree.findByInitialPath(resolvedAbs);
    }
    for (const candidate of moduleCandidates(resolvedAbs)) {
        const n = tree.findByInitialPath(candidate);
        if (n) return n;
    }
    // Folder import (no `index.*` matched, but the directory itself is tracked).
    const asDir = tree.findByInitialPath(resolvedAbs);
    if (asDir) return asDir;
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
    return toRelativeImportSpec(importerCurrentDir, target);
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
