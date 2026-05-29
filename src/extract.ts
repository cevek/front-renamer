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
import {ts} from './ts-loader.js';
import type {NormalizedExtractOp} from './schema.js';
import type {ProjectInfo} from './preflight.js';
import {VFSTree} from './vfs.js';
import type {RenameEngine} from './rename.js';
import {coExtractCssModules, type CssCoExtractReport} from './extract-css.js';
import {postProcessExtractedFile} from './extract-postprocess.js';
import {getModuleSpecifier, resolveSpecifierToInitialPath} from './imports.js';
import {applyEdits, applyTsTextChanges, emitQuoted} from './text-edits.js';
import {findTopLevelDeclaration} from './ts-decl.js';
import {moduleCandidates, toRelativeImportSpec} from './module-resolve.js';
import {safeStat} from './fs-util.js';
import type {FsNode} from './vfs.js';

/**
 * Structured per-op failure. Carries enough metadata for the CLI to group ops
 * by `category` and emit one compact line per op (instead of 5+ verbose lines
 * each that all repeat the same root cause).
 */
export type ExtractFailureCategory =
    | 'ts-ls-internal'
    | 'ts-ls-no-edits-move-to-file'
    | 'ts-ls-declined-move-to-new-file';

export class ExtractFailure extends Error {
    readonly category: ExtractFailureCategory;
    readonly op: NormalizedExtractOp;
    readonly context: string;
    constructor(category: ExtractFailureCategory, op: NormalizedExtractOp, context: string) {
        super(`[${category}] op#${op.index} ${op.extract}: ${context}`);
        this.category = category;
        this.op = op;
        this.context = context;
    }
}

export class ExtractEngine {
    private service: ts.LanguageService;
    private versions = new Map<string, number>();
    /** Co-extraction reports, exposed to bin.ts for output. */
    readonly cssReports: CssCoExtractReport[] = [];
    /**
     * Symbol-level moves performed by extract ops. Used in `rewriteSymbolConsumers`
     * to catch consumer files whose imports the TS LS couldn't update — typically
     * files synthesised by earlier extract ops in the same batch (LS only updates
     * consumers in its program; new VFS nodes aren't published to the LS).
     */
    private extractedSymbols: Array<{symbol: string; fromAbs: string; toAbs: string}> = [];
    /**
     * Per-op warnings (e.g. extracting a value that looks like data/schema, CSS
     * co-extract sub-failures). Collected and printed grouped at the end, not
     * streamed mid-run.
     */
    readonly warnings: Array<{index: number; symbol: string; from: string; to: string; reason: string}> = [];

    constructor(
        readonly project: ProjectInfo,
        private tree: VFSTree,
        // Kept for future Phase 3 features (rename after extract, etc.).
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        _renames: RenameEngine,
    ) {
        const sourceFiles = new Set(project.sourceFiles);
        // VFS-first host: TS LS sees any file/dir living in the tree as if it
        // existed on disk. Lets us run "Move to file" against synthesised
        // targets without ever writing a physical stub — the IDE no longer
        // flashes ghost files mid-run, and dry-mode is truly zero-write.
        const host: ts.LanguageServiceHost = {
            getCompilationSettings: () => project.compilerOptions,
            getScriptFileNames: () => {
                // Original tsconfig roots PLUS any new path we synthesised
                // (extract targets, retargeted files). De-dup on canonical key.
                const out = new Set<string>(sourceFiles);
                for (const node of this.tree.iterFiles()) {
                    out.add(node.currentPath());
                }
                return Array.from(out);
            },
            getScriptVersion: (fileName) => String(this.versions.get(fileName) ?? 0),
            getScriptSnapshot: (fileName) => {
                const text = this.readByInitialPath(fileName);
                return text !== null ? ts.ScriptSnapshot.fromString(text) : undefined;
            },
            getCurrentDirectory: () => project.root,
            getDefaultLibFileName: ts.getDefaultLibFilePath,
            fileExists: (p) => {
                const byInit = this.tree.findByInitialPath(p);
                if (byInit && byInit.kind === 'file') return true;
                const byCur = this.tree.findByCurrentPath(p);
                if (byCur && byCur.kind === 'file') return true;
                return safeStat(p)?.isFile() ?? false;
            },
            readFile: (p) => this.readByInitialPath(p) ?? undefined,
            directoryExists: (p) => {
                // TS resolves module specifiers by probing parent directories;
                // it must see the new directories the batch synthesised for
                // extract targets (e.g. extracted helpers in fresh subdirs).
                const node = this.tree.findByCurrentPath(p);
                if (node && node.kind === 'dir') return true;
                return safeStat(p)?.isDirectory() ?? false;
            },
            getDirectories: ts.sys.getDirectories,
            realpath: ts.sys.realpath,
        };
        this.service = ts.createLanguageService(host, ts.createDocumentRegistry());
    }

    /**
     * Run the post-process pass on every TS/TSX file in the tree. Idempotent.
     * Catches type-import/`.ts` extension/`node_modules` quirks introduced by
     * TS LS across multiple extracts that touch shared consumer files.
     */
    postProcessAllTouched(): void {
        for (const node of this.tree.iterFiles()) {
            if (!node.hasContentOverride()) continue;
            if (!/\.(tsx?|jsx?)$/.test(node.currentName)) continue;
            const before = node.readContent();
            const after = postProcessExtractedFile(before, {
                fileAbs: node.currentPath(),
                compilerOptions: this.project.compilerOptions,
            });
            if (after !== before) node.setContent(after);
        }
    }

    /**
     * No-op now: the LS host is VFS-aware, so extracts no longer write physical
     * stubs. Kept on the API so the engine's `finally`-block call still
     * compiles and old callers don't need to know we eliminated disk writes.
     */
    cleanupDiskStubs(): void {
        /* nothing to clean — extracts no longer touch disk */
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
        // No physical stub on disk — the LS host (see constructor) answers
        // `fileExists`/`directoryExists` from the VFS, so TS LS sees the target
        // module without us ever writing a file. Bumps the version so any
        // cached LS state is invalidated for this round.
        if (intoExisting) this.bumpVersion(op.toAbs);
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
                    throw new ExtractFailure('ts-ls-no-edits-move-to-file', op, '');
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
                    throw new ExtractFailure('ts-ls-declined-move-to-new-file', op, '');
                }
            }
        } catch (err) {
            const message = (err as Error).message ?? String(err);
            if (
                message.includes('Expected symbol to be a module') ||
                message.includes('Debug Failure')
            ) {
                // Throw a structured failure — the CLI groups by category and
                // prints a single short line per op (the long verbose form just
                // burns tokens when 60+ ops share the same root cause).
                throw new ExtractFailure('ts-ls-internal', op, buildExtractFailureContext(sf, op));
            }
            throw err;
        }

        // Dedup edits by VFS-node identity BEFORE applying. The LS may emit
        // two edits for one logical file when the file was previously
        // synthesised under a different name (e.g. op#N created `Foo.tsx`
        // and we renamed it to `helpers.ts`, then op#N+1 generates edits
        // addressed to BOTH paths). Applying both corrupts the content.
        //
        // Strategy: when two changes resolve to the same node, prefer the one
        // whose fileName matches the op's INTENDED target — that's the edit
        // the LS computed against helpers.ts's actual content, while the alias
        // one is a stale snapshot that just adds an import.
        const dedupedChanges = dedupeFileChangesByNode(edits.edits, this.tree, op.toAbs);

        let createdInitialPath: string | null = null;
        for (const fileChange of dedupedChanges) {
            if (fileChange.isNewFile) {
                const newContent = applyTsTextChanges('', fileChange.textChanges);
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
                const after = applyTsTextChanges(before, fileChange.textChanges);
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

        // ---- Post-process EVERY file the LS touched: type-only flips,
        // node_modules paths, and `.ts/.tsx` extension stripping. Apply to the
        // target AND to source + consumers so all files are normalised. ----
        const filesTouched = new Set<string>();
        for (const fileChange of edits.edits) {
            filesTouched.add(fileChange.fileName);
        }
        if (!intoExisting && createdInitialPath) filesTouched.add(op.toAbs);
        for (const fileAbs of filesTouched) {
            const node =
                this.tree.findByInitialPath(fileAbs) ?? this.tree.findByCurrentPath(fileAbs);
            if (!node) continue;
            if (!/\.(tsx?|jsx?)$/.test(node.currentName)) continue;
            const before = node.readContent();
            const after = postProcessExtractedFile(before, {
                fileAbs: node.currentPath(),
                compilerOptions: this.project.compilerOptions,
            });
            if (after !== before) node.setContent(after);
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
                    // Don't let CSS analysis crash the whole extract; surface the
                    // miss in the deferred warnings report.
                    this.warnings.push({
                        index: op.index,
                        symbol: op.extract,
                        from: op.from,
                        to: op.to,
                        reason: `CSS co-extract failed: ${(err as Error).message}`,
                    });
                }
            }
        }

        // Track the symbol move so the post-pass can fix consumers the LS missed
        // (e.g. files synthesised by an earlier extract op in this same batch).
        this.extractedSymbols.push({symbol: op.extract, fromAbs: op.fromAbs, toAbs: op.toAbs});
    }

    /**
     * Sweep every VFS file and patch consumer imports where TS LS missed the
     * symbol move. Triggers when an `import { ..., S, ... } from <fromAbs>`
     * survives even though S has moved to `<toAbs>` in this batch. Rewrite to
     * import S from the new target file, preserving any sibling bindings.
     *
     * Why this exists: TS LS' "Move to file" only updates consumers it can see
     * in its program. Files created by earlier extract ops live in the VFS but
     * aren't published to the LS, so their imports are never patched.
     */
    rewriteSymbolConsumers(): void {
        if (this.extractedSymbols.length === 0) return;
        // Group moves by source file → symbol → newAbs (last write wins if a
        // symbol was somehow extracted twice).
        const movesBySource = new Map<string, Map<string, string>>();
        for (const m of this.extractedSymbols) {
            let inner = movesBySource.get(m.fromAbs);
            if (!inner) {
                inner = new Map();
                movesBySource.set(m.fromAbs, inner);
            }
            inner.set(m.symbol, m.toAbs);
        }

        for (const node of this.tree.iterFiles()) {
            if (!/\.(tsx?|jsx?)$/.test(node.currentName)) continue;
            const before = node.readContent();
            const after = rewriteConsumerImportsForSymbolMoves({
                content: before,
                fileNode: node,
                tree: this.tree,
                project: this.project,
                movesBySource,
            });
            if (after !== before) node.setContent(after);
        }
    }

    private findDeclarationPosition(sf: ts.SourceFile, name: string): number | null {
        return findTopLevelDeclaration(sf, name)?.pos ?? null;
    }
}

/**
 * If the named symbol is a `const X = <expr>` where <expr> is a call (e.g.
 * `z.object(...)`, `create(...)`) and the identifier is uppercase-first, it's
 * very likely DATA, not a component/hook. Returns a short human-readable
 * description, or null if nothing to warn about.
 */
/** Collect enough surface info about a failed extract to triage the cause. */
function buildExtractFailureContext(sf: ts.SourceFile, op: NormalizedExtractOp): string {
    let aliasImports = 0;
    let relativeImports = 0;
    let typeOnlyImports = 0;
    let topLevelStatements = 0;
    let topLevelExports = 0;
    for (const stmt of sf.statements) {
        topLevelStatements++;
        if (ts.isImportDeclaration(stmt)) {
            const spec = ts.isStringLiteral(stmt.moduleSpecifier) ? stmt.moduleSpecifier.text : '';
            if (spec.startsWith('.')) relativeImports++;
            else if (spec.length > 0) aliasImports++;
            if (stmt.importClause?.isTypeOnly) typeOnlyImports++;
        }
        const mods = ts.canHaveModifiers(stmt) ? ts.getModifiers(stmt) : undefined;
        if (mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) topLevelExports++;
    }
    const parts = [
        `${topLevelStatements} top-level statements`,
        `${topLevelExports} exports`,
        `${aliasImports} alias imports`,
        `${relativeImports} relative imports`,
    ];
    if (typeOnlyImports > 0) parts.push(`${typeOnlyImports} type-only imports`);
    if (op.from === op.to) parts.push('from === to');
    return parts.join(', ');
}

function findDeclarationStatement(sf: ts.SourceFile, name: string): ts.Statement | null {
    return findTopLevelDeclaration(sf, name)?.statement ?? null;
}

// `applyTextChanges` / `applyEdits` / quote-preservation all live in
// `./text-edits.ts` now — see imports at the top.

/**
 * Patch a single consumer file's imports when symbols it imports have moved
 * between files due to extract ops. The TS LS already handles consumers in its
 * program, but files created by earlier extracts in the same batch are invisible
 * to the LS — we catch those here.
 *
 * The strategy: split each import declaration whose specifier resolves to a
 * known `fromAbs`. Keep non-moved bindings on the original import; emit fresh
 * import declarations for each destination. New specifiers anchor relative to
 * the consumer's INITIAL dir; `rewriteAllImports` runs after this and normalises
 * everything to current locations.
 */
/**
 * Collapse LS file changes that target the SAME VFS node under different
 * names (LS-chosen path vs. our renamed currentPath). For each node, prefer
 * the change whose fileName matches the op's intended target (`op.toAbs`) —
 * that change is the one computed against the live VFS content. The alias
 * one is a leftover from the LS's stale internal book-keeping and only
 * patches imports, which produces self-referential nonsense when applied
 * to the same node.
 *
 * New-file changes (`isNewFile`) are never collapsed — they create distinct
 * tree nodes and have nothing to dedup against.
 */
function dedupeFileChangesByNode(
    changes: readonly ts.FileTextChanges[],
    tree: VFSTree,
    intendedTarget: string,
): ts.FileTextChanges[] {
    const groupsByNode = new Map<FsNode, ts.FileTextChanges[]>();
    const out: ts.FileTextChanges[] = [];

    for (const change of changes) {
        if (change.isNewFile) {
            out.push(change);
            continue;
        }
        const node =
            tree.findByInitialPath(change.fileName) ?? tree.findByCurrentPath(change.fileName);
        if (!node) {
            // Unknown file — pass through, let the caller raise its own error.
            out.push(change);
            continue;
        }
        const list = groupsByNode.get(node) ?? [];
        list.push(change);
        groupsByNode.set(node, list);
    }

    for (const list of groupsByNode.values()) {
        if (list.length === 1) {
            out.push(list[0]);
            continue;
        }
        // Multiple edits for one node — pick the canonical one.
        const canonical = list.find((c) => c.fileName === intendedTarget) ?? list[list.length - 1];
        out.push(canonical);
    }
    return out;
}

function rewriteConsumerImportsForSymbolMoves(args: {
    content: string;
    fileNode: FsNode;
    tree: import('./vfs.js').VFSTree;
    project: ProjectInfo;
    movesBySource: Map<string, Map<string, string>>;
}): string {
    const {content, fileNode, project, movesBySource} = args;
    const initialDir = path.dirname(fileNode.initialPath());

    const sf = ts.createSourceFile(
        fileNode.initialPath(),
        content,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
    );

    const edits: Array<{start: number; end: number; text: string}> = [];

    for (const stmt of sf.statements) {
        if (!ts.isImportDeclaration(stmt)) continue;
        const moduleSpec = getModuleSpecifier(stmt);
        if (!moduleSpec) continue;
        const spec = moduleSpec.text;
        const resolved = resolveSpecifierToInitialPath(spec, initialDir, project);
        if (!resolved) continue;

        // Match the resolved path against move sources, trying common module
        // extensions like locateTargetNode does. Whichever extension hits gives us
        // the bindings map.
        let movedMap: Map<string, string> | null = null;
        for (const candidate of moduleCandidates(resolved)) {
            const hit = movesBySource.get(candidate);
            if (hit) {
                movedMap = hit;
                break;
            }
        }
        if (!movedMap) continue;

        const clause = stmt.importClause;
        if (!clause?.namedBindings || !ts.isNamedImports(clause.namedBindings)) continue;
        const elems = clause.namedBindings.elements;
        const stay: ts.ImportSpecifier[] = [];
        // Group moved bindings by destination so we can emit one import per dest.
        const moveTo = new Map<string, Array<{name: string; alias: string | null; typeOnly: boolean}>>();
        const clauseTypeOnly = clause.isTypeOnly === true;
        for (const elem of elems) {
            const importedName = (elem.propertyName ?? elem.name).text;
            const localName = elem.name.text;
            const dest = movedMap.get(importedName);
            if (!dest) {
                stay.push(elem);
                continue;
            }
            const list = moveTo.get(dest) ?? [];
            list.push({
                name: importedName,
                alias: importedName === localName ? null : localName,
                typeOnly: elem.isTypeOnly === true,
            });
            moveTo.set(dest, list);
        }
        if (moveTo.size === 0) continue;

        // Emit:
        //  - If anything stays, rewrite the original import with only those bindings.
        //  - Otherwise, drop the original entirely.
        //  - Always append one new import per destination.
        const defaultPart = clause.name ? `${clause.name.text}, ` : '';
        const newLines: string[] = [];
        if (stay.length > 0 || clause.name) {
            const stayTexts = stay.map((e) =>
                `${e.isTypeOnly ? 'type ' : ''}${e.propertyName ? `${e.propertyName.text} as ${e.name.text}` : e.name.text}`,
            );
            const keyword = clauseTypeOnly ? 'import type ' : 'import ';
            const namedPart = stayTexts.length > 0 ? `{ ${stayTexts.join(', ')} }` : '';
            const fromPart = emitQuoted(content, moduleSpec.getStart(sf), spec);
            const composed = stayTexts.length > 0 || clause.name
                ? `${keyword}${defaultPart}${namedPart} from ${fromPart};`
                : '';
            if (composed) newLines.push(composed);
        }
        for (const [destAbs, items] of moveTo) {
            const newSpec = toRelativeImportSpec(initialDir, destAbs, {stripTsExt: true});
            const allType = clauseTypeOnly || items.every((i) => i.typeOnly);
            const keyword = allType ? 'import type ' : 'import ';
            const itemTexts = items.map((i) => {
                const head = !allType && i.typeOnly ? 'type ' : '';
                return `${head}${i.alias ? `${i.name} as ${i.alias}` : i.name}`;
            });
            const newQuoted = emitQuoted(content, moduleSpec.getStart(sf), newSpec);
            newLines.push(`${keyword}{ ${itemTexts.join(', ')} } from ${newQuoted};`);
        }

        edits.push({
            start: stmt.getStart(sf),
            end: stmt.getEnd(),
            text: newLines.join('\n'),
        });
    }

    return applyEdits(content, edits);
}

// `resolvedCandidates` removed — use `moduleCandidates` from `./module-resolve.js`.

// `relativeSpec` removed — use `toRelativeImportSpec(fromDir, toAbs, {stripTsExt: true})`.

// `quote` removed — use `emitQuoted` from `./text-edits.ts`.
