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
import * as ts from 'typescript';
import type {ProjectInfo} from './preflight.js';
import {type FsNode, type VFSTree} from './vfs.js';

export class RenameEngine {
    private versions = new Map<string, number>();
    private service: ts.LanguageService;

    constructor(private project: ProjectInfo, private tree: VFSTree) {
        const sourceFiles = new Set(project.sourceFiles);
        const host: ts.LanguageServiceHost = {
            getCompilationSettings: () => project.compilerOptions,
            getScriptFileNames: () => Array.from(sourceFiles),
            getScriptVersion: (fileName) => String(this.versions.get(fileName) ?? 0),
            getScriptSnapshot: (fileName) => {
                const text = this.readByInitialPath(fileName);
                return text !== null ? ts.ScriptSnapshot.fromString(text) : undefined;
            },
            getCurrentDirectory: () => project.root,
            getDefaultLibFileName: ts.getDefaultLibFilePath,
            fileExists: (p) => safeStat(p)?.isFile() ?? false,
            readFile: (p) => {
                const text = this.readByInitialPath(p);
                return text ?? undefined;
            },
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

        const locations =
            this.service.findRenameLocations(initialPath, position, false, false, false) ?? [];
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
            const sorted = spans.sort((a, b) => b.start - a.start);
            let next = content;
            for (const s of sorted) {
                next = next.slice(0, s.start) + newName + next.slice(s.end);
            }
            if (next !== content) {
                node.setContent(next);
                this.versions.set(fileName, (this.versions.get(fileName) ?? 0) + 1);
                touched++;
            }
        }
        return {touched};
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
            ts.forEachChild(node, visit);
        };
        visit(sf);
        return pos;
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
        let base: string | null = null;
        if (spec.startsWith('.')) base = path.resolve(importerDir, spec);
        else {
            for (const {aliasPrefix, absPrefix} of this.project.aliasPrefixes) {
                if (spec === aliasPrefix.slice(0, -1) || spec.startsWith(aliasPrefix)) {
                    base = path.resolve(absPrefix, spec.slice(aliasPrefix.length));
                    break;
                }
            }
        }
        if (!base) return null;
        for (const c of [base, base + '.tsx', base + '.ts', path.join(base, 'index.tsx'), path.join(base, 'index.ts')]) {
            try {
                if (fs.statSync(c).isFile()) return c;
            } catch {
                /* skip */
            }
        }
        return null;
    }
}

function safeStat(p: string): fs.Stats | null {
    try {
        return fs.statSync(p);
    } catch {
        return null;
    }
}
