/**
 * Native TypeScript typecheck via the compiler API — no subprocess, no project-
 * specific package-manager command. Reads the configured tsconfig and emits
 * pre-emit diagnostics.
 */
import * as path from 'node:path';
import * as ts from 'typescript';

export interface TypecheckResult {
    ok: boolean;
    /** Pretty-formatted diagnostics output (empty when ok=true). */
    output: string;
    /** Raw diagnostics for programmatic use. */
    diagnostics: readonly ts.Diagnostic[];
}

export function runTypecheck(tsconfigPath: string): TypecheckResult {
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

    const program = ts.createProgram(parsed.fileNames, options);
    const diagnostics = ts.getPreEmitDiagnostics(program);
    if (diagnostics.length === 0) return {ok: true, output: '', diagnostics};

    const host: ts.FormatDiagnosticsHost = {
        getCurrentDirectory: () => process.cwd(),
        getCanonicalFileName: (f) => f,
        getNewLine: () => ts.sys.newLine,
    };
    const output = ts.formatDiagnosticsWithColorAndContext(diagnostics, host);
    return {ok: false, output, diagnostics};
}
