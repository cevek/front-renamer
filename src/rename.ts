/**
 * Identifier rename via the TypeScript Language Service. Tree-VFS aware:
 *
 *   - Source files are read by their CURRENT path the language service host
 *     reports back (we keep the originally-loaded names for stability and
 *     return content via the tree node).
 *   - Renames update the node's content override; subsequent passes see the
 *     post-rename text when they `node.readContent()`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {ts} from './ts-loader.js';
import type {ProjectInfo} from './preflight.js';
import {type FsNode, type VFSTree} from './vfs.js';
import {applyEdits} from './text-edits.js';
import {findTopLevelDeclaration} from './ts-decl.js';
import {moduleCandidates, resolveSpecifierBase} from './module-resolve.js';
import {safeStat} from './fs-util.js';

export class RenameEngine {
    private versions = new Map<string, number>();
    private service: ts.LanguageService;

    constructor(private project: ProjectInfo, private tree: VFSTree) {
        const sourceFiles = new Set(project.sourceFiles);
        const host: ts.LanguageServiceHost = {
            getCompilationSettings: () => project.compilerOptions,
            // Include any file the tree currently knows about — covers files
            // produced by extract before a subsequent rename can see them.
            getScriptFileNames: () => {
                const all = new Set(sourceFiles);
                for (const node of this.tree.iterFiles()) {
                    if (/\.(ts|tsx)$/.test(node.initialName)) all.add(node.initialPath());
                }
                return Array.from(all);
            },
            getScriptVersion: (fileName) => this.computeVersion(fileName),
            getScriptSnapshot: (fileName) => {
                const text = this.readByInitialPath(fileName);
                return text !== null ? ts.ScriptSnapshot.fromString(text) : undefined;
            },
            getCurrentDirectory: () => project.root,
            getDefaultLibFileName: ts.getDefaultLibFilePath,
            fileExists: (p) => {
                if (this.tree.findByInitialPath(p)) return true;
                return safeStat(p)?.isFile() ?? false;
            },
            readFile: (p) => this.readByInitialPath(p) ?? undefined,
            directoryExists: (p) => safeStat(p)?.isDirectory() ?? false,
            getDirectories: (p) => {
                try {
                    return fs
                        .readdirSync(p, {withFileTypes: true})
                        .filter((e) => e.isDirectory())
                        .map((e) => e.name);
                } catch {
                    return [];
                }
            },
            realpath: ts.sys.realpath,
        };
        this.service = ts.createLanguageService(host, ts.createDocumentRegistry());
    }

    /**
     * Version is `<localBump>:<contentHash>`. The hash changes whenever the
     * VFS node's content overlay changes — guarantees the LS notices edits made
     * by ExtractEngine (or any earlier rename op). djb2 (32-bit) is plenty for
     * cache invalidation and avoids length-only collisions (e.g. swapping two
     * identifiers of equal length).
     */
    private computeVersion(fileName: string): string {
        const node = this.tree.findByInitialPath(fileName);
        const bump = this.versions.get(fileName) ?? 0;
        if (!node?.hasContentOverride()) return `${bump}:0`;
        return `${bump}:${djb2(node.readContent())}`;
    }

    private readByInitialPath(initialAbs: string): string | null {
        const node = this.tree.findByInitialPath(initialAbs);
        if (node) return node.readContent();
        try {
            return fs.readFileSync(initialAbs, 'utf8');
        } catch {
            return null;
        }
    }

    /**
     * Rename the symbol declared in `declNode` (a file node) and propagate to
     * every reference in the program. Also re-binds matching default-import locals.
     */
    rename(declNode: FsNode, oldName: string, newName: string): {touched: number} {
        const initialPath = declNode.initialPath();
        const program = this.service.getProgram();
        if (!program) throw new Error('language service has no program');
        const sf = program.getSourceFile(initialPath);
        if (!sf) {
            console.warn(`  ⚠ language service didn't load: ${initialPath}`);
            return {touched: 0};
        }

        const position = this.findDeclarationPosition(sf, oldName);
        if (position === null) return {touched: 0};

        // `providePrefixAndSuffixTextForRename = true` lets TS emit shorthand-property
        // disambiguation like `{Foo: Bar}` instead of corrupting `{Foo}` destructures.
        const locations =
            this.service.findRenameLocations(initialPath, position, false, false, true) ?? [];
        const extra = this.findMatchingDefaultImportLocals(program, initialPath, oldName);

        const byFile = new Map<string, Array<{start: number; end: number}>>();
        const seen = new Set<string>();
        for (const loc of [...locations, ...extra]) {
            const start = loc.textSpan.start;
            const end = loc.textSpan.start + loc.textSpan.length;
            const key = `${loc.fileName}:${start}:${end}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const list = byFile.get(loc.fileName) ?? [];
            list.push({start, end});
            byFile.set(loc.fileName, list);
        }

        let touched = 0;
        for (const [fileName, spans] of byFile) {
            const node = this.tree.findByInitialPath(fileName);
            if (!node) continue;
            const content = node.readContent();
            const next = applyEdits(
                content,
                spans.map((s) => ({start: s.start, end: s.end, text: newName})),
            );
            if (next !== content) {
                node.setContent(next);
                this.versions.set(fileName, (this.versions.get(fileName) ?? 0) + 1);
                touched++;
            }
        }
        return {touched};
    }

    /** Delegates to shared `findTopLevelDeclaration` — returns only the position. */
    private findDeclarationPosition(sf: ts.SourceFile, name: string): number | null {
        return findTopLevelDeclaration(sf, name)?.pos ?? null;
    }

    private findMatchingDefaultImportLocals(
        program: ts.Program,
        declaringFile: string,
        oldName: string,
    ): Array<{fileName: string; textSpan: {start: number; length: number}}> {
        const out: Array<{fileName: string; textSpan: {start: number; length: number}}> = [];
        const declAbs = path.resolve(declaringFile);
        for (const sf of program.getSourceFiles()) {
            if (sf.isDeclarationFile) continue;
            for (const stmt of sf.statements) {
                if (!ts.isImportDeclaration(stmt)) continue;
                const clause = stmt.importClause;
                if (!clause?.name) continue;
                if (clause.name.text !== oldName) continue;
                if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue;
                const resolved = this.resolveSpec(stmt.moduleSpecifier.text, path.dirname(sf.fileName));
                if (resolved === declAbs) {
                    out.push({
                        fileName: sf.fileName,
                        textSpan: {start: clause.name.getStart(sf), length: clause.name.getWidth(sf)},
                    });
                }
            }
        }
        return out;
    }

    private resolveSpec(spec: string, importerDir: string): string | null {
        const base = resolveSpecifierBase(spec, importerDir, this.project);
        if (!base) return null;
        for (const c of moduleCandidates(base)) {
            try {
                if (fs.statSync(c).isFile()) return c;
            } catch {
                /* skip */
            }
        }
        return null;
    }
}

/** djb2 — cheap 32-bit content hash for LS cache-invalidation versioning. */
function djb2(s: string): string {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i);
    return (h >>> 0).toString(16);
}
