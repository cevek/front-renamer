/**
 * Post-process the content of a freshly-extracted file BEFORE it goes into
 * the VFS. Two transforms, both safe (semantics-preserving):
 *
 *   1. **type-only imports** — if a named import is only used in type
 *      positions (annotations, generics, `satisfies`), promote it to
 *      `import { type Foo }` so projects with `verbatimModuleSyntax: true`
 *      compile.
 *
 *   2. **node_modules path normalisation** — TS LS sometimes emits relative
 *      paths into `node_modules`, e.g.
 *        `import type { z } from '../../node_modules/zod/v4/classic/external.d.cts'`
 *      Rewrite back to the bare package name (`'zod'`) by climbing the path
 *      until we find a `package.json` inside `node_modules/<scope?>/<pkg>/`.
 *
 * Both transforms ONLY touch imports the TS LS emitted; they don't apply to
 * the broader codebase. Idempotent — running twice is a no-op.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {ts} from './ts-loader.js';
import {applyEdits, emitQuoted} from './text-edits.js';

export interface PostProcessOptions {
    /** Absolute path of the extracted file (used to resolve relative imports). */
    fileAbs: string;
    /** Compiler options — read `verbatimModuleSyntax` to know whether to add `type`. */
    compilerOptions: ts.CompilerOptions;
}

export function postProcessExtractedFile(content: string, opts: PostProcessOptions): string {
    const enableTypeImports = opts.compilerOptions.verbatimModuleSyntax === true;
    const allowTsExt = opts.compilerOptions.allowImportingTsExtensions === true;
    let next = content;
    next = normalizeNodeModulesImports(next, opts.fileAbs);
    if (!allowTsExt) next = stripTsExtensionsInImports(next, opts.fileAbs);
    if (enableTypeImports) next = promoteTypeOnlyImports(next, opts.fileAbs);
    return next;
}

/**
 * TS LS occasionally emits `from './foo.ts'` / `'.tsx'` even when the project
 * doesn't enable `allowImportingTsExtensions`. Strip the extension in that
 * case (verbatimModuleSyntax with this setting OFF rejects it as TS5097).
 */
function stripTsExtensionsInImports(content: string, fileAbs: string): string {
    const sf = ts.createSourceFile(fileAbs, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const edits: Array<{start: number; end: number; text: string}> = [];
    const visit = (node: ts.Node) => {
        if (ts.isStringLiteral(node) && isModuleSpecifierContext(node)) {
            const spec = node.text;
            // Relative or alias only — never strip from bare package paths.
            if ((spec.startsWith('.') || spec.startsWith('@/')) && /\.(tsx?|jsx?)$/.test(spec)) {
                const stripped = spec.replace(/\.(tsx?|jsx?)$/, '');
                edits.push({
                    start: node.getStart(sf),
                    end: node.getEnd(),
                    text: emitQuoted(content, node.getStart(sf), stripped),
                });
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(sf);
    return applyEdits(content, edits);
}

// ---------- node_modules path normalisation ----------

function normalizeNodeModulesImports(content: string, fileAbs: string): string {
    const sf = ts.createSourceFile(fileAbs, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const edits: Array<{start: number; end: number; text: string}> = [];

    const importerDir = path.dirname(fileAbs);
    const visit = (node: ts.Node) => {
        if (ts.isStringLiteral(node) && isModuleSpecifierContext(node)) {
            const spec = node.text;
            if (spec.includes('/node_modules/')) {
                const pkg = extractPackageName(spec, importerDir);
                if (pkg) {
                    edits.push({
                        start: node.getStart(sf),
                        end: node.getEnd(),
                        text: emitQuoted(content, node.getStart(sf), pkg),
                    });
                }
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(sf);
    return applyEdits(content, edits);
}

function isModuleSpecifierContext(literal: ts.StringLiteral): boolean {
    const p = literal.parent;
    if (!p) return false;
    if (ts.isImportDeclaration(p) && p.moduleSpecifier === literal) return true;
    if (ts.isExportDeclaration(p) && p.moduleSpecifier === literal) return true;
    if (
        ts.isCallExpression(p) &&
        p.expression.kind === ts.SyntaxKind.ImportKeyword &&
        p.arguments[0] === literal
    ) {
        return true;
    }
    return false;
}

/**
 * Extract the package name from a path that includes `/node_modules/`.
 * Resolves to absolute first, then walks the segments looking for the package
 * root (the dir that has its OWN `package.json`).
 */
function extractPackageName(spec: string, importerDir: string): string | null {
    let abs: string;
    if (spec.startsWith('.')) abs = path.resolve(importerDir, spec);
    else if (path.isAbsolute(spec)) abs = spec;
    else return null;

    const idx = abs.lastIndexOf('/node_modules/');
    if (idx < 0) return null;
    const inside = abs.slice(idx + '/node_modules/'.length);
    const parts = inside.split('/');
    if (parts.length === 0) return null;
    // Scoped packages: `@org/name/...`.
    const candidate = parts[0].startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
    // Confirm by reading package.json `name` (don't assume).
    const pkgRoot = abs.slice(0, idx + '/node_modules/'.length) + candidate;
    try {
        const pj = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'));
        if (typeof pj.name === 'string') return pj.name;
    } catch {
        /* fallthrough */
    }
    return candidate;
}

// ---------- type-only import promotion ----------

function promoteTypeOnlyImports(content: string, fileAbs: string): string {
    const sf = ts.createSourceFile(fileAbs, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const edits: Array<{start: number; end: number; text: string}> = [];

    // Collect identifier usages: identifier text → set of positions used in TYPE context.
    const valueUses = new Set<string>();
    const typeUses = new Set<string>();

    const visit = (node: ts.Node, inType: boolean) => {
        if (ts.isImportDeclaration(node)) return; // skip import nodes themselves
        if (ts.isIdentifier(node)) {
            const inTypeNow = inType || isInTypePosition(node);
            if (inTypeNow) typeUses.add(node.text);
            else valueUses.add(node.text);
            return;
        }
        if (
            ts.isTypeReferenceNode(node) ||
            ts.isTypeQueryNode(node) ||
            ts.isInterfaceDeclaration(node) ||
            ts.isTypeAliasDeclaration(node) ||
            ts.isTypeLiteralNode(node)
        ) {
            ts.forEachChild(node, (child) => visit(child, true));
            return;
        }
        ts.forEachChild(node, (child) => visit(child, inType));
    };

    for (const stmt of sf.statements) {
        if (ts.isImportDeclaration(stmt)) continue;
        if (ts.isExportDeclaration(stmt)) {
            // `export [type] { X, [type] Y }` from another module OR re-exporting
            // a top-level binding. The ExportSpecifier identifier is NOT a value
            // use — it's a binding reference that follows the clause/spec type
            // flag. Falling through to the generic visit treats it as a bare
            // identifier and miscounts `export type { X }` as a value use.
            const clauseTypeOnly = stmt.isTypeOnly;
            if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
                for (const spec of stmt.exportClause.elements) {
                    const name = (spec.propertyName ?? spec.name).text;
                    if (clauseTypeOnly || spec.isTypeOnly) typeUses.add(name);
                    else valueUses.add(name);
                }
            }
            continue;
        }
        visit(stmt, false);
    }

    // Walk imports and synthesise the correct shape per declaration. Two directions:
    //   (a) `import { X }` where X is used ONLY as a type → add `type` to X.
    //   (b) `import type { X }` (or `import type ... { X, ... }`) where X is used
    //       as a VALUE → strip the `type` from that binding (or from the whole
    //       clause if every binding ends up non-type).
    // The second is critical when TS LS guesses wrong (common for zod-style
    // `import type { z }` while the code does `z.object(...)`).
    for (const stmt of sf.statements) {
        if (!ts.isImportDeclaration(stmt)) continue;
        const clause = stmt.importClause;
        if (!clause) continue;
        if (!clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) {
            // Default-only or namespace import — leave alone here; usage of those
            // forms is rare in TS LS-emitted code.
            continue;
        }

        const declaredTypeOnly = clause.isTypeOnly;
        const elems = clause.namedBindings.elements;

        // Classify each binding.
        const decisions: Array<{name: string; wantType: boolean}> = [];
        for (const elem of elems) {
            const local = elem.name.text;
            const usedAsValue = valueUses.has(local);
            const usedAsType = typeUses.has(local);
            // Value usage is decisive — can't be type-only if anyone calls it / reads it.
            const wantType = !usedAsValue && usedAsType;
            decisions.push({name: local, wantType});
        }

        // Decide the new shape:
        //   - If every binding wants type → keep `import type { ... }` (or promote if it wasn't).
        //   - If every binding is value-shaped → strip clause-level `type`.
        //   - Mixed → emit clause-level NON-type-only and prepend `type ` per binding that wants it.
        const allType = decisions.every((d) => d.wantType);
        const anyValue = decisions.some((d) => !d.wantType);

        const needsRewrite =
            // Clause-level mismatch
            allType !== declaredTypeOnly ||
            // Or some binding mismatch (only possible when clause isn't already all-type).
            (anyValue && elems.some((e, i) => e.isTypeOnly !== decisions[i].wantType));

        if (!needsRewrite) continue;

        const specifier = ts.isStringLiteral(stmt.moduleSpecifier)
            ? content.slice(stmt.moduleSpecifier.getStart(sf), stmt.moduleSpecifier.getEnd())
            : stmt.moduleSpecifier.getText(sf);
        const defaultImport = clause.name ? clause.name.text : null;

        const bindingTexts = decisions.map((d) => (d.wantType && !allType ? `type ${d.name}` : d.name));
        const clauseKeyword = allType ? 'import type ' : 'import ';
        const namedPart = `{ ${bindingTexts.join(', ')} }`;
        const defaultPart = defaultImport ? `${defaultImport}, ` : '';
        const rewritten = `${clauseKeyword}${defaultPart}${namedPart} from ${specifier};`;

        edits.push({
            start: stmt.getStart(sf),
            end: stmt.getEnd(),
            text: rewritten,
        });
    }

    return applyEdits(content, edits);
}

function isInTypePosition(node: ts.Node): boolean {
    let cur: ts.Node | undefined = node.parent;
    while (cur) {
        if (
            ts.isTypeNode(cur) ||
            ts.isTypeReferenceNode(cur) ||
            ts.isTypeQueryNode(cur) ||
            ts.isTypeAliasDeclaration(cur) ||
            ts.isInterfaceDeclaration(cur)
        ) {
            return true;
        }
        // Generic argument list of a call/new (`f<X>(...)`) — `X` is type.
        if (ts.isCallExpression(cur) || ts.isNewExpression(cur) || ts.isTaggedTemplateExpression(cur)) {
            const args = (cur as ts.CallExpression).typeArguments;
            if (args && args.some((a) => a === node || isAncestor(a, node))) return true;
            return false;
        }
        if (
            ts.isPropertySignature(cur) ||
            ts.isMethodSignature(cur) ||
            ts.isIndexSignatureDeclaration(cur)
        ) {
            return true;
        }
        if (ts.isFunctionLike(cur)) {
            // Stop at function bodies — type annotations on parameters/return are TypeNodes already.
            return false;
        }
        cur = cur.parent;
    }
    return false;
}

function isAncestor(ancestor: ts.Node, descendant: ts.Node): boolean {
    let cur: ts.Node | undefined = descendant;
    while (cur) {
        if (cur === ancestor) return true;
        cur = cur.parent;
    }
    return false;
}

// `emitSameQuoteStyle` / `applyEdits` removed — use `emitQuoted` / `applyEdits`
// from `./text-edits.ts` (imported above).
