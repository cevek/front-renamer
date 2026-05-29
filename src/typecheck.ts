/**
 * Native TypeScript typecheck via the compiler API — no subprocess, no project-
 * specific package-manager command. Reads the configured tsconfig and emits
 * pre-emit diagnostics.
 *
 * Supports an optional VFS overlay so a dry-run can typecheck the post-batch
 * state of the project WITHOUT writing anything to disk. Overlay entries can
 * (a) add a new file, (b) change content at an existing path, or (c) mark a
 * file as "moved away" so its old path stops existing for resolution.
 */
import * as path from 'node:path';
import {ts} from './ts-loader.js';

export interface TypecheckResult {
    ok: boolean;
    /** Pretty-formatted diagnostics output (empty when ok=true). */
    output: string;
    /** Raw diagnostics for programmatic use. */
    diagnostics: readonly ts.Diagnostic[];
}

export interface VirtualFile {
    /** Absolute path where this file logically exists (post-move location). */
    path: string;
    /** Post-batch content. */
    content: string;
    /**
     * Original on-disk path of this file before the batch. If set AND different
     * from `path`, the typecheck will treat the old location as deleted (so
     * stale imports of the old path surface as missing-module errors).
     */
    initialPath?: string;
}

export function runTypecheck(tsconfigPath: string, overlay?: VirtualFile[]): TypecheckResult {
    const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
    if (configFile.error) {
        return {
            ok: false,
            output: `failed to read tsconfig: ${configFile.error.messageText}`,
            diagnostics: [configFile.error],
        };
    }
    const parsed = ts.parseJsonConfigFileContent(
        configFile.config,
        ts.sys,
        path.dirname(tsconfigPath),
    );
    // Force `noEmit: true` — we only want diagnostics, not output files.
    const options: ts.CompilerOptions = {
        ...parsed.options,
        noEmit: true,
        // Disable incremental tsbuildinfo to avoid polluting the project tree.
        incremental: false,
        tsBuildInfoFile: undefined,
    };

    const overlayResult = buildOverlay(overlay);
    const rootFiles = computeRootFiles(parsed.fileNames, overlayResult);
    const host = buildCompilerHost(options, overlayResult);

    const program = ts.createProgram(rootFiles, options, host);
    const diagnostics = ts.getPreEmitDiagnostics(program);
    if (diagnostics.length === 0) return {ok: true, output: '', diagnostics};

    const formatHost: ts.FormatDiagnosticsHost = {
        getCurrentDirectory: () => process.cwd(),
        getCanonicalFileName: (f) => f,
        getNewLine: () => ts.sys.newLine,
    };
    // Plain format (no ANSI). Agents and CI pipes consume this output; colour
    // codes only inflate token counts without helping readability.
    const output = ts.formatDiagnostics(diagnostics, formatHost);
    return {ok: false, output, diagnostics};
}

// ---------- overlay infrastructure ----------

interface BuiltOverlay {
    /** canonical → original case-preserved path (one entry per file). */
    originalByCanon: Map<string, string>;
    /** canonical → post-batch content. */
    contentByCanon: Map<string, string>;
    /** Paths the batch removed — canonical form. VFS-host pretends gone. */
    removed: Set<string>;
    /** Whether path comparisons should be case-insensitive (matches host). */
    caseSensitive: boolean;
}

function buildOverlay(overlay: VirtualFile[] | undefined): BuiltOverlay | null {
    if (!overlay || overlay.length === 0) return null;
    const caseSensitive = ts.sys.useCaseSensitiveFileNames;
    const canon = (p: string) => canonicalPath(p, caseSensitive);
    const originalByCanon = new Map<string, string>();
    const contentByCanon = new Map<string, string>();
    const removed = new Set<string>();
    for (const f of overlay) {
        const c = canon(f.path);
        originalByCanon.set(c, f.path);
        contentByCanon.set(c, f.content);
        if (f.initialPath && canon(f.initialPath) !== c) {
            removed.add(canon(f.initialPath));
        }
    }
    // A file overwritten in place (path === initialPath) MUST NOT also be in
    // `removed` — defensive cleanup in case caller listed both forms.
    for (const c of contentByCanon.keys()) removed.delete(c);
    return {originalByCanon, contentByCanon, removed, caseSensitive};
}

/**
 * Build the root-file list passed to `ts.createProgram`. Start from whatever
 * tsconfig included, drop paths that moved away, add new overlay paths.
 */
function computeRootFiles(configFiles: readonly string[], overlay: BuiltOverlay | null): string[] {
    if (!overlay) return [...configFiles];
    const canon = (p: string) => canonicalPath(p, overlay.caseSensitive);
    // Deduplicate by canonical form, but emit the ORIGINAL case-preserved path.
    // Mixing canonical (lowercase on case-insensitive FS) and original forms in
    // the root list makes TS see two different files per real file → TS6383.
    const byCanon = new Map<string, string>();
    for (const f of configFiles) {
        const c = canon(f);
        if (overlay.removed.has(c)) continue;
        // Overlay-overridden files: prefer the overlay's case (it carries the
        // post-batch path, which may differ from disk casing).
        const overlayOriginal = overlay.originalByCanon.get(c);
        byCanon.set(c, overlayOriginal ?? f);
    }
    for (const [c, original] of overlay.originalByCanon) {
        if (!byCanon.has(c)) byCanon.set(c, original);
    }
    return Array.from(byCanon.values());
}

function buildCompilerHost(
    options: ts.CompilerOptions,
    overlay: BuiltOverlay | null,
): ts.CompilerHost {
    const base = ts.createCompilerHost(options, true);
    // Belt-and-braces: `noEmit: true` in options already prevents emit, but we
    // ALSO neutralise writeFile on the host so a future TS API change or
    // misconfigured tsconfig can never accidentally splatter `.js`/`.d.ts`
    // alongside source. The dry-run promise is "nothing touches disk", end of.
    base.writeFile = () => {};
    if (!overlay) return base;
    const canon = (p: string) => canonicalPath(p, overlay.caseSensitive);

    return {
        ...base,
        fileExists: (filePath: string): boolean => {
            const c = canon(filePath);
            if (overlay.contentByCanon.has(c)) return true;
            if (overlay.removed.has(c)) return false;
            return base.fileExists(filePath);
        },
        readFile: (filePath: string): string | undefined => {
            const c = canon(filePath);
            const o = overlay.contentByCanon.get(c);
            if (o !== undefined) return o;
            if (overlay.removed.has(c)) return undefined;
            return base.readFile(filePath);
        },
        getSourceFile: (
            filePath: string,
            languageVersionOrOptions: ts.ScriptTarget | ts.CreateSourceFileOptions,
            onError?: (m: string) => void,
            shouldCreateNewSourceFile?: boolean,
        ): ts.SourceFile | undefined => {
            const c = canon(filePath);
            const content = overlay.contentByCanon.get(c);
            if (content !== undefined) {
                // Use the OVERLAY's case-preserved path as the source file's
                // `fileName` — must match what we put in the root file list,
                // otherwise TS sees the same file under two cases (TS1149).
                const realPath = overlay.originalByCanon.get(c) ?? filePath;
                // `setParentNodes=true` — downstream tools that walk the AST
                // expect parent pointers wired up.
                return ts.createSourceFile(realPath, content, languageVersionOrOptions, true);
            }
            if (overlay.removed.has(c)) return undefined;
            return base.getSourceFile(filePath, languageVersionOrOptions, onError, shouldCreateNewSourceFile);
        },
    };
}

function canonicalPath(p: string, caseSensitive: boolean): string {
    // Normalize separators to forward slashes — matches what TS does internally
    // when canonicalising file paths.
    const slashed = p.replace(/\\/g, '/');
    return caseSensitive ? slashed : slashed.toLowerCase();
}
