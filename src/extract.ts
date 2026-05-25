/**
 * Extract a top-level symbol from a source TS/TSX file into a new file via the
 * TypeScript language service's "Move to a new file" refactor.
 *
 * Flow:
 *   1. Locate the declaration position of `extract` symbol inside `from`.
 *   2. Ask the language service for the refactor edits.
 *   3. Apply edits to the in-memory tree: create the new file node, update the
 *      source file's content.
 *   4. If the language service chose a different on-disk path for the new file
 *      than what the op asked for, move it via the tree's normal moveTo.
 *   5. Symbol identifier renames in the source file (when the user passes
 *      `renameSymbols` later, in a separate op) work as before — extract is
 *      strictly the cut-and-create part.
 *
 * CSS handling is OUT of scope here for the "none" mode: the extracted file
 * keeps a relative import to the source's sibling stylesheet, if any was used.
 */
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import type {NormalizedExtractOp} from './schema.js';
import type {ProjectInfo} from './preflight.js';
import {VFSTree} from './vfs.js';
import type {RenameEngine} from './rename.js';
import {coExtractCssModules, type CssCoExtractReport} from './extract-css.js';

export class ExtractEngine {
    private service: ts.LanguageService;
    private versions = new Map<string, number>();
    /**
     * Stub files we wrote to disk just so TypeScript could see the target as a
     * real module. In dry-run these are cleaned up at the end of the run. In
     * apply mode commit() overwrites them with the real post-extract content.
     */
    readonly diskStubs: string[] = [];
    /** Directories we created on disk for stubs. Removed on dry cleanup (deepest first). */
    private createdDirs: string[] = [];
    /** Co-extraction reports, exposed to bin.ts for output. */
    readonly cssReports: CssCoExtractReport[] = [];

    /** Walk up the path creating only the dirs that didn't exist; remember them for cleanup. */
    private ensureDirWithRollback(dir: string): void {
        const segments: string[] = [];
        let cur = dir;
        while (cur && !fsSync.existsSync(cur) && cur !== path.dirname(cur)) {
            segments.unshift(cur);
            cur = path.dirname(cur);
        }
        for (const s of segments) {
            fsSync.mkdirSync(s);
            this.createdDirs.push(s);
        }
    }

    constructor(
        readonly project: ProjectInfo,
        private tree: VFSTree,
        // Kept for future Phase 3 features (rename after extract, etc.).
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        _renames: RenameEngine,
    ) {
        const sourceFiles = new Set(project.sourceFiles);
        const host: ts.LanguageServiceHost = {
            getCompilationSettings: () => project.compilerOptions,
            // Include any files we wrote stubs for, so TS LS treats them as in-program.
            getScriptFileNames: () => Array.from(new Set([...sourceFiles, ...this.diskStubs])),
            getScriptVersion: (fileName) => String(this.versions.get(fileName) ?? 0),
            getScriptSnapshot: (fileName) => {
                const text = this.readByInitialPath(fileName);
                return text !== null ? ts.ScriptSnapshot.fromString(text) : undefined;
            },
            getCurrentDirectory: () => project.root,
            getDefaultLibFileName: ts.getDefaultLibFilePath,
            fileExists: (p) => safeStat(p)?.isFile() ?? false,
            readFile: (p) => this.readByInitialPath(p) ?? undefined,
            directoryExists: (p) => safeStat(p)?.isDirectory() ?? false,
            getDirectories: ts.sys.getDirectories,
            realpath: ts.sys.realpath,
        };
        this.service = ts.createLanguageService(host, ts.createDocumentRegistry());
    }

    /** Remove any stubs (and dirs we created for them) written during extract. */
    cleanupDiskStubs(): void {
        for (const p of this.diskStubs) {
            try {
                fsSync.unlinkSync(p);
            } catch {
                /* already gone */
            }
        }
        this.diskStubs.length = 0;
        // Deepest first so children go before parents.
        const dirs = [...this.createdDirs].sort((a, b) => b.length - a.length);
        for (const d of dirs) {
            try {
                if (fsSync.readdirSync(d).length === 0) fsSync.rmdirSync(d);
            } catch {
                /* not empty / already gone */
            }
        }
        this.createdDirs.length = 0;
    }

    private readByInitialPath(initialAbs: string): string | null {
        const node = this.tree.findByInitialPath(initialAbs);
        if (node) return node.readContent();
        try {
            return fsSync.readFileSync(initialAbs, 'utf8');
        } catch {
            return null;
        }
    }

    private bumpVersion(fileName: string): void {
        this.versions.set(fileName, (this.versions.get(fileName) ?? 0) + 1);
    }

    extract(op: NormalizedExtractOp): void {
        const fromNode = this.tree.findByInitialPath(op.fromAbs);
        if (!fromNode) {
            throw new Error(`extract op#${op.index}: source file not in tree: ${op.from}`);
        }

        // Choose path:
        //  • Target node exists in the tree (on disk OR synthesised by an earlier
        //    extract) → "Move to file" — merge into it.
        //  • Otherwise → "Move to a new file" — TS picks a filename, we re-target
        //    it via tree.moveTo() to op.toAbs.
        const targetNode = this.tree.findByInitialPath(op.toAbs) ?? this.tree.findByCurrentPath(op.toAbs);
        const intoExisting = targetNode !== null;

        // For merging into an existing file, ensure a physical stub exists. TS LS
        // needs to resolve the target as a module symbol when computing imports.
        if (intoExisting && !fsSync.existsSync(op.toAbs)) {
            // Track dirs we create so we can roll them back in dry mode.
            this.ensureDirWithRollback(path.dirname(op.toAbs));
            fsSync.writeFileSync(op.toAbs, targetNode!.readContent());
            this.diskStubs.push(op.toAbs);
        }
        const sourceContent = fromNode.readContent();
        // Source might be `.ts` (no JSX) — parsing as TSX can misread `<T>x` casts.
        const sourceKind = /\.tsx$/i.test(op.fromAbs) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
        const sf = ts.createSourceFile(
            fromNode.initialPath(),
            sourceContent,
            ts.ScriptTarget.Latest,
            true,
            sourceKind,
        );

        const declarationPos = this.findDeclarationPosition(sf, op.extract);
        if (declarationPos === null) {
            throw new Error(
                `extract op#${op.index}: symbol "${op.extract}" not found as a top-level declaration in ${op.from}`,
            );
        }

        const preferences: ts.UserPreferences = {allowTextChangesInNewFiles: true};
        const declStatement = findDeclarationStatement(sf, op.extract);
        const range: ts.TextRange = declStatement
            ? {pos: declStatement.getStart(sf), end: declStatement.getEnd()}
            : {pos: declarationPos, end: declarationPos};

        let edits: ts.RefactorEditInfo | undefined;
        try {
            if (intoExisting) {
                edits = this.service.getEditsForRefactor(
                    fromNode.initialPath(),
                    {convertTabsToSpaces: true, tabSize: 2, indentSize: 2},
                    range,
                    'Move to file',
                    'Move to file',
                    preferences,
                    {targetFile: op.toAbs},
                );
                if (!edits || edits.edits.length === 0) {
                    throw new Error(
                        `extract op#${op.index}: TypeScript produced no edits for "Move to file" of "${op.extract}" → ${op.to}. Known TS LS limitation when merging into a target that imports types or aliases — extract this symbol to a distinct file instead, or do it manually.`,
                    );
                }
            } else {
                edits = this.service.getEditsForRefactor(
                    fromNode.initialPath(),
                    {convertTabsToSpaces: true, tabSize: 2, indentSize: 2},
                    range,
                    'Move to a new file',
                    'Move to a new file',
                    preferences,
                );
                if (!edits || edits.edits.length === 0) {
                    throw new Error(
                        `extract op#${op.index}: TypeScript declined "Move to a new file" for "${op.extract}" in ${op.from}. Make sure it's a top-level export and the file has multiple top-level statements.`,
                    );
                }
            }
        } catch (err) {
            const message = (err as Error).message ?? String(err);
            if (message.includes('Expected symbol to be a module')) {
                throw new Error(
                    `extract op#${op.index}: hit a TypeScript language-service assertion while refactoring "${op.extract}" from ${op.from} → ${op.to}. This is a known TS LS limitation, usually triggered by complex import alias resolution in the source file's dependencies. Workaround: extract this symbol manually for now.`,
                );
            }
            throw err;
        }

        // Apply edits.
        let createdInitialPath: string | null = null;
        for (const fileChange of edits.edits) {
            if (fileChange.isNewFile) {
                const newContent = applyTextChanges('', fileChange.textChanges);
                const dir = path.dirname(fileChange.fileName);
                const filename = path.basename(fileChange.fileName);
                const parent = this.tree.ensureDirAtCurrent(dir);
                if (parent.childByCurrent(filename)) {
                    throw new Error(
                        `extract op#${op.index}: TS picked an existing filename ${fileChange.fileName} — pick a different "extract" target.`,
                    );
                }
                this.tree.addFileAtCurrent(parent, filename, newContent);
                createdInitialPath = fileChange.fileName;
            } else {
                let node = this.tree.findByInitialPath(fileChange.fileName);
                if (!node) node = this.tree.findByCurrentPath(fileChange.fileName);
                if (!node) {
                    throw new Error(`extract op#${op.index}: edits target unknown file ${fileChange.fileName}`);
                }
                const before = node.readContent();
                const after = applyTextChanges(before, fileChange.textChanges);
                node.setContent(after);
                this.bumpVersion(fileChange.fileName);
            }
        }

        if (!intoExisting) {
            if (!createdInitialPath) {
                throw new Error(`extract op#${op.index}: refactor produced no new file`);
            }
            if (createdInitialPath !== op.toAbs) {
                const createdNode = this.tree.findByCurrentPath(createdInitialPath);
                if (!createdNode) {
                    throw new Error(`extract op#${op.index}: created node not findable at ${createdInitialPath}`);
                }
                const targetParent = this.tree.ensureDirAtCurrent(path.dirname(op.toAbs));
                createdNode.moveTo(targetParent, path.basename(op.toAbs));
                // Re-key byInitialPath so subsequent `findByInitialPath(op.toAbs)` works.
                this.tree.rekeyByInitialPath(createdNode, createdInitialPath, op.toAbs);
            }
        }

        // Co-extract CSS Modules if requested.
        if (op.css === 'copy-safe') {
            const sourceNode = this.tree.findByInitialPath(op.fromAbs);
            const targetNode =
                this.tree.findByInitialPath(op.toAbs) ?? this.tree.findByCurrentPath(op.toAbs);
            if (sourceNode && targetNode) {
                try {
                    const reports = coExtractCssModules({
                        sourceNode,
                        targetNode,
                        sourceContentPostExtract: sourceNode.readContent(),
                        extractedContent: targetNode.readContent(),
                        tree: this.tree,
                    });
                    this.cssReports.push(...reports);
                } catch (err) {
                    // Don't let CSS analysis crash the whole extract.
                    console.warn(`  ⚠ op#${op.index}: CSS co-extract failed: ${(err as Error).message}`);
                }
            }
        }
    }

    private findDeclarationPosition(sf: ts.SourceFile, name: string): number | null {
        let pos: number | null = null;
        const visit = (node: ts.Node) => {
            if (pos !== null) return;
            if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
                pos = node.name.getStart(sf);
                return;
            }
            if (ts.isClassDeclaration(node) && node.name?.text === name) {
                pos = node.name.getStart(sf);
                return;
            }
            if (ts.isVariableStatement(node)) {
                for (const decl of node.declarationList.declarations) {
                    if (ts.isIdentifier(decl.name) && decl.name.text === name) {
                        pos = decl.name.getStart(sf);
                        return;
                    }
                }
            }
            if (ts.isInterfaceDeclaration(node) && node.name.text === name) {
                pos = node.name.getStart(sf);
                return;
            }
            if (ts.isTypeAliasDeclaration(node) && node.name.text === name) {
                pos = node.name.getStart(sf);
                return;
            }
            // Only walk the top level — the "Move to a new file" refactor only
            // applies to top-level declarations.
        };
        sf.forEachChild(visit);
        return pos;
    }
}

function findDeclarationStatement(sf: ts.SourceFile, name: string): ts.Statement | null {
    for (const stmt of sf.statements) {
        if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === name) return stmt;
        if (ts.isClassDeclaration(stmt) && stmt.name?.text === name) return stmt;
        if (ts.isInterfaceDeclaration(stmt) && stmt.name.text === name) return stmt;
        if (ts.isTypeAliasDeclaration(stmt) && stmt.name.text === name) return stmt;
        if (ts.isVariableStatement(stmt)) {
            for (const decl of stmt.declarationList.declarations) {
                if (ts.isIdentifier(decl.name) && decl.name.text === name) return stmt;
            }
        }
    }
    return null;
}

function applyTextChanges(original: string, changes: readonly ts.TextChange[]): string {
    // Sort right-to-left so positions don't shift as we apply.
    const sorted = [...changes].sort((a, b) => b.span.start - a.span.start);
    let next = original;
    for (const c of sorted) {
        next = next.slice(0, c.span.start) + c.newText + next.slice(c.span.start + c.span.length);
    }
    return next;
}

function safeStat(p: string): fsSync.Stats | null {
    try {
        return fsSync.statSync(p);
    } catch {
        return null;
    }
}
