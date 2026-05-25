/**
 * Co-extract CSS Modules classes alongside a TS LS Move-to-file/new-file extract.
 *
 * Strategy is intentionally conservative:
 *   1. Find every default-import of a `.module.scss/.css` in the source file.
 *   2. Find every `s.X` reference inside the EXTRACTED block of source AST.
 *   3. Parse the source stylesheet (postcss-scss for .scss, postcss for .css).
 *   4. For each referenced `.X`:
 *        - safe → move into a new stylesheet next to the extracted .tsx
 *        - unsafe → leave in source stylesheet, report reason
 *   5. Rewrite the extracted file's stylesheet import(s):
 *        - if some classes moved: keep a relative import to the old file too
 *          (for the unsafe ones), and add a NEW import for the new file. This
 *          is intentionally ugly — it makes the partial migration visible.
 *
 * A class is SAFE when:
 *   - It appears as a single class selector (or `.X:pseudo` / `.X::pseudo` /
 *     `.X.modifier-class` patterns where the OTHER class isn't referenced).
 *   - The rule body has no `@include`, `@extend`, `@if`, `@for`, `@each`,
 *     `@mixin`, `@function`, `@import`, `@use`, or `@forward`.
 *   - The rule isn't nested inside another rule (root-level).
 *   - The class isn't referenced by ANY OTHER rule in the same stylesheet
 *     (as part of a compound selector, descendant, sibling, or @extend).
 *   - The class isn't referenced by the REMAINING source TSX (only by code
 *     that's being extracted).
 *
 * Anything failing any check → unsafe → user fixes manually.
 */
import * as path from 'node:path';
import * as ts from 'typescript';
import postcss, {AtRule, Rule, type Root} from 'postcss';
import postcssScss from 'postcss-scss';
import type {FsNode, VFSTree} from './vfs.js';

export interface CssCoExtractReport {
    sourceStylesheet: string;
    targetStylesheet: string;
    moved: string[];
    /** class → reason */
    leftBehind: Array<{class: string; reason: string}>;
}

export interface CssCoExtractOptions {
    sourceNode: FsNode; // source TSX (post-edit, i.e. without extracted block)
    targetNode: FsNode; // extracted TSX (just created/merged)
    sourceContentPostExtract: string; // remaining source content
    extractedContent: string; // brand-new content of target
    tree: VFSTree;
}

export function coExtractCssModules(opts: CssCoExtractOptions): CssCoExtractReport[] {
    const reports: CssCoExtractReport[] = [];

    // Discover css-module imports once for the "what classes are referenced"
    // analysis (offsets here are STABLE because we don't mutate `extractedContent`
    // — every per-import rewrite is reapplied by re-parsing the current content).
    const initialExtractedSf = ts.createSourceFile(
        opts.targetNode.currentPath(),
        opts.extractedContent,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
    );
    const initialImports = findCssModuleImports(initialExtractedSf);
    if (initialImports.length === 0) return reports;

    const extractedReferences = new Map<string, Set<string>>();
    collectMemberAccesses(initialExtractedSf, initialImports.map((c) => c.localName), extractedReferences);

    // Remaining-source references: if ANY usage of the local import name is
    // non-trivial (spread, destructure, computed `s[expr]`, rebind via const/let),
    // we conservatively treat every class in that stylesheet as still-used.
    const remainingSf = ts.createSourceFile(
        opts.sourceNode.currentPath(),
        opts.sourceContentPostExtract,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
    );
    const remainingReferences = new Map<string, Set<string>>();
    const remainingWildcard = new Set<string>();
    collectMemberAccessesStrict(
        remainingSf,
        initialImports.map((c) => c.localName),
        remainingReferences,
        remainingWildcard,
    );

    // Two distinct anchors:
    //   - `extractedInitialDir`  — where TS LS THOUGHT the file would live; the
    //     base for resolving the relative specifiers it emitted.
    //   - `extractedCurrentDir`  — where the file actually ends up; the base for
    //     emitting NEW specifiers (toward the freshly-created stylesheet).
    const extractedInitialDir = path.dirname(opts.targetNode.initialPath());
    const extractedCurrentDir = path.dirname(opts.targetNode.currentPath());

    for (const imp of initialImports) {
        // Re-find imports in the CURRENT extracted content so offsets are valid
        // when the loop has already mutated it for a previous import.
        const currentSf = ts.createSourceFile(
            opts.targetNode.currentPath(),
            opts.targetNode.readContent(),
            ts.ScriptTarget.Latest,
            true,
            ts.ScriptKind.TSX,
        );
        const currentImp = findCssModuleImports(currentSf).find(
            (i) => i.localName === imp.localName && i.specifier === imp.specifier,
        );
        if (!currentImp) continue;

        if (!currentImp.specifier.startsWith('.')) {
            reports.push({
                sourceStylesheet: currentImp.specifier,
                targetStylesheet: '',
                moved: [],
                leftBehind: [
                    {
                        class: '*',
                        reason: `aliased import "${currentImp.specifier}" — resolve manually`,
                    },
                ],
            });
            continue;
        }

        // Resolve against the initial (LS-chosen) dir — that's where the spec is anchored.
        const sheetPath = path.resolve(extractedInitialDir, currentImp.specifier);

        // Look up the stylesheet via the tree (so dry mode doesn't touch disk).
        const sheetNode = opts.tree.findByCurrentPath(sheetPath) ?? opts.tree.findByInitialPath(sheetPath);
        if (!sheetNode) continue;

        const ext = path.extname(sheetPath);
        const isSass = ext === '.scss' || ext === '.sass';
        const raw = sheetNode.readContent();
        const root = (isSass ? postcssScss : postcss).parse(raw) as Root;

        const refsInExtracted = extractedReferences.get(currentImp.localName) ?? new Set<string>();
        const refsInRemaining = remainingReferences.get(currentImp.localName) ?? new Set<string>();
        // If the remaining source uses the import name in a non-trivial way
        // (spread, destructure, computed access, rebind), treat EVERY class in
        // the sheet as still-used — conservative but safe.
        const remainingIsWildcard = remainingWildcard.has(currentImp.localName);
        if (refsInExtracted.size === 0) continue;

        const moved: string[] = [];
        const leftBehind: Array<{class: string; reason: string}> = [];

        for (const cls of refsInExtracted) {
            const stillUsedInRemaining = remainingIsWildcard || refsInRemaining.has(cls);
            const verdict = isClassSafeToMove(root, cls, stillUsedInRemaining);
            if (verdict === 'safe') moved.push(cls);
            else leftBehind.push({class: cls, reason: verdict});
        }
        if (moved.length === 0 && leftBehind.length === 0) continue;

        // The NEW stylesheet sits next to the extracted file's FINAL location.
        const newSheetPath = makeNewStylesheetPath(extractedCurrentDir, opts.targetNode.currentName);
        if (moved.length > 0) {
            // Build new stylesheet content (only safe rules + their leading comment blocks).
            const newRoot = postcss.parse('');
            const movedRules = new Set<Rule>();
            for (const cls of moved) {
                for (const node of findOwnedRules(root, cls)) movedRules.add(node);
            }
            for (const rule of movedRules) {
                // Carry immediately-preceding sibling comments (block + line) along
                // so we don't strip docstrings from a rule that we just moved.
                const leading = collectLeadingComments(rule);
                for (const c of leading) newRoot.append(c.clone());
                newRoot.append(rule.clone());
            }
            const newCss = newRoot.toString();

            // Create or update the new stylesheet via VFS (NOT disk).
            const targetDirNode = opts.tree.ensureDirAtCurrent(path.dirname(newSheetPath));
            const existingNewNode = targetDirNode.childByCurrent(path.basename(newSheetPath));
            if (existingNewNode) {
                existingNewNode.setContent(existingNewNode.readContent() + '\n' + newCss);
            } else {
                opts.tree.addFileAtCurrent(targetDirNode, path.basename(newSheetPath), newCss);
            }

            // Remove the moved rules (and their leading comments) from the old stylesheet.
            const updatedRoot = root.clone() as Root;
            const toRemove: Array<Rule | postcss.Comment> = [];
            updatedRoot.walkRules((r) => {
                if (moved.some((cls) => isOwnedBy(r, cls))) {
                    for (const c of collectLeadingComments(r)) toRemove.push(c);
                    toRemove.push(r);
                }
            });
            for (const n of toRemove) n.remove();
            sheetNode.setContent(updatedRoot.toString());
        }

        reports.push({
            sourceStylesheet: sheetPath,
            targetStylesheet: newSheetPath,
            moved,
            leftBehind,
        });

        // Update the extracted file's import(s) and class references.
        if (moved.length > 0) {
            // Both specifiers must be expressed from the file's FINAL directory.
            const newRel = relativeImportSpec(extractedCurrentDir, newSheetPath);
            const legacyRel = relativeImportSpec(extractedCurrentDir, sheetPath);
            const leftBehindClasses = new Set(leftBehind.map((lb) => lb.class));
            const updatedContent = updateExtractedImportsAndRefs(
                opts.targetNode.readContent(),
                currentImp,
                newRel,
                legacyRel,
                leftBehindClasses,
            );
            opts.targetNode.setContent(updatedContent);
        }
    }

    return reports;
}

// ----------------- helpers -----------------

interface CssImport {
    localName: string;
    specifier: string;
    /** Position of the import declaration's `moduleSpecifier` (for editing). */
    specifierStart: number;
    specifierEnd: number;
    /** Start of the import declaration itself. */
    importStart: number;
    importEnd: number;
}

function findCssModuleImports(sf: ts.SourceFile): CssImport[] {
    const out: CssImport[] = [];
    for (const stmt of sf.statements) {
        if (!ts.isImportDeclaration(stmt)) continue;
        if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue;
        const spec = stmt.moduleSpecifier.text;
        if (!/\.(module\.scss|module\.css|scss|css)$/.test(spec)) continue;
        const def = stmt.importClause?.name;
        if (!def) continue;
        out.push({
            localName: def.text,
            specifier: spec,
            specifierStart: stmt.moduleSpecifier.getStart(sf),
            specifierEnd: stmt.moduleSpecifier.getEnd(),
            importStart: stmt.getStart(sf),
            importEnd: stmt.getEnd(),
        });
    }
    return out;
}

function collectMemberAccesses(
    sf: ts.SourceFile,
    localNames: string[],
    out: Map<string, Set<string>>,
): void {
    // Permissive variant: only literal `s.X` / `s['X']` (used for the EXTRACTED file
    // since we generated its content from TS LS and don't have weird patterns).
    const names = new Set(localNames);
    const visit = (node: ts.Node) => {
        if (ts.isPropertyAccessExpression(node)) {
            if (ts.isIdentifier(node.expression) && names.has(node.expression.text)) {
                const set = out.get(node.expression.text) ?? new Set<string>();
                set.add(node.name.text);
                out.set(node.expression.text, set);
            }
        } else if (ts.isElementAccessExpression(node)) {
            if (ts.isIdentifier(node.expression) && names.has(node.expression.text)) {
                const arg = node.argumentExpression;
                if (arg && ts.isStringLiteral(arg)) {
                    const set = out.get(node.expression.text) ?? new Set<string>();
                    set.add(arg.text);
                    out.set(node.expression.text, set);
                }
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(sf);
}

/**
 * Strict variant for the REMAINING source file. If the local import name
 * escapes "I am accessed exactly once with a literal key" — via spread,
 * destructuring, rebind, computed access, function arg, etc. — we add it to
 * `wildcard` so the caller knows to treat the entire stylesheet as still-used.
 */
function collectMemberAccessesStrict(
    sf: ts.SourceFile,
    localNames: string[],
    out: Map<string, Set<string>>,
    wildcard: Set<string>,
): void {
    const names = new Set(localNames);
    const recordLiteral = (ln: string, member: string) => {
        const set = out.get(ln) ?? new Set<string>();
        set.add(member);
        out.set(ln, set);
    };
    const flagWildcard = (ln: string) => wildcard.add(ln);

    const visit = (node: ts.Node) => {
        if (ts.isIdentifier(node) && names.has(node.text)) {
            // Look at the parent to classify the usage.
            const parent = node.parent;
            if (!parent) {
                ts.forEachChild(node, visit);
                return;
            }
            // Allowed: `s.X` (PropertyAccessExpression where `s` is the expression).
            if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
                recordLiteral(node.text, parent.name.text);
            }
            // Allowed: `s['X']` (ElementAccessExpression with literal).
            else if (
                ts.isElementAccessExpression(parent) &&
                parent.expression === node &&
                ts.isStringLiteral(parent.argumentExpression)
            ) {
                recordLiteral(node.text, parent.argumentExpression.text);
            }
            // Not allowed: `s[expr]` with non-literal, spread `{...s}`, destructure
            // `const {x} = s`, rebind `const t = s`, function call `f(s)`,
            // type-only or import position, etc. — flag wildcard.
            else if (
                ts.isElementAccessExpression(parent) &&
                parent.expression === node
                // arg is non-literal → wildcard
            ) {
                flagWildcard(node.text);
            } else if (
                // Skip the identifier appearing in its own declaration site
                // (`import s from "..."`, `import { s }`, etc.).
                ts.isImportClause(parent) ||
                ts.isImportSpecifier(parent) ||
                ts.isNamespaceImport(parent)
            ) {
                // ignore — this is the binding site, not a use
            } else {
                flagWildcard(node.text);
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(sf);
}

const UNSAFE_AT_RULES = new Set([
    'include', 'extend', 'if', 'for', 'each', 'while',
    'mixin', 'function', 'import', 'use', 'forward', 'debug', 'warn', 'error',
]);

/** Returns 'safe' OR a reason string. */
function isClassSafeToMove(root: Root, cls: string, usedInRemaining: boolean): string {
    if (usedInRemaining) {
        return 'still used by code remaining in source file';
    }
    const owning: Rule[] = [];
    let referencedElsewhere = false;
    let unsafeReason: string | null = null;

    root.walkRules((rule) => {
        const sel = rule.selector;
        if (selectorIsOwnedBy(sel, cls)) {
            // Must be at the root, not nested inside another rule.
            if (rule.parent && rule.parent.type !== 'root') {
                unsafeReason = `rule is nested inside another selector`;
                return;
            }
            // Inspect body for unsafe at-rules / vars.
            for (const child of rule.nodes ?? []) {
                if (child.type === 'atrule' && UNSAFE_AT_RULES.has((child as AtRule).name)) {
                    unsafeReason = `uses @${(child as AtRule).name}`;
                    return;
                }
                if (child.type === 'rule') {
                    unsafeReason = `has nested rules`;
                    return;
                }
            }
            // Sass-variable refs in declarations are flagged conservatively.
            rule.walkDecls((decl) => {
                if (/\$[A-Za-z_]/.test(decl.value)) {
                    unsafeReason = `references a Sass variable`;
                }
            });
            owning.push(rule);
        } else if (selectorReferences(sel, cls)) {
            referencedElsewhere = true;
        }
    });

    if (unsafeReason !== null) return unsafeReason;
    if (owning.length === 0) return 'no rule found for this class';
    if (referencedElsewhere) return 'class appears in a compound selector elsewhere';

    // Look for @extend on this class anywhere.
    let extendsThis = false;
    root.walkAtRules('extend', (atrule) => {
        const param = atrule.params.trim();
        if (param === '.' + cls) extendsThis = true;
    });
    if (extendsThis) return '@extend %X / .X referenced from another rule';

    return 'safe';
}

/**
 * "Owned" = the rule is dedicated to `cls` and ONLY `cls`. Allowed forms:
 *   .X
 *   .X:pseudo            (e.g. :hover, :focus-visible)
 *   .X::pseudo           (e.g. ::before)
 *   .X:pseudo:pseudo     (chained pseudos OK)
 * NOT allowed (would mix ownership with another class):
 *   .X.modifier          (`.modifier` is another class — taking the rule would
 *                         silently relocate styling that ALSO targets `.modifier`)
 *   .outer .X            (descendant)
 *   .X.Y                 (compound)
 * Selector lists `A, B, C` are owned by `cls` only if EVERY branch is owned.
 */
function selectorIsOwnedBy(selector: string, cls: string): boolean {
    const sels = selector.split(',').map((s) => s.trim());
    if (sels.length === 0) return false;
    const escaped = escapeRe(cls);
    // Require either `.cls` exact, or `.cls` followed only by pseudo chains.
    const re = new RegExp(`^\\.${escaped}(:{1,2}[\\w-]+(\\([^)]*\\))?)*$`);
    return sels.every((s) => re.test(s));
}

function selectorReferences(selector: string, cls: string): boolean {
    // Any appearance of `.cls` outside of an owning rule means the class is
    // entangled with something else — descendant (`.outer .X`), compound
    // (`.X.Y`), sibling (`.X + .Y`), or part of a selector list with mixed
    // owners.
    if (selectorIsOwnedBy(selector, cls)) return false;
    const re = new RegExp(`\\.${escapeRe(cls)}([^\\w-]|$)`);
    return re.test(selector);
}

function isOwnedBy(rule: Rule, cls: string): boolean {
    return selectorIsOwnedBy(rule.selector, cls);
}

/** Walk back from a rule, collecting immediate comment siblings (until first non-comment). */
function collectLeadingComments(rule: Rule): postcss.Comment[] {
    const out: postcss.Comment[] = [];
    let prev = rule.prev();
    while (prev && prev.type === 'comment') {
        out.unshift(prev as postcss.Comment);
        prev = prev.prev();
    }
    return out;
}

function findOwnedRules(root: Root, cls: string): Rule[] {
    const out: Rule[] = [];
    root.walkRules((r) => {
        if (isOwnedBy(r, cls)) out.push(r);
    });
    return out;
}

function makeNewStylesheetPath(dir: string, targetTsxName: string): string {
    const base = targetTsxName.replace(/\.(tsx?|jsx?)$/, '');
    return path.join(dir, `${base}.module.scss`);
}

function relativeImportSpec(fromDir: string, absPath: string): string {
    let rel = path.relative(fromDir, absPath).split(path.sep).join('/');
    if (!rel.startsWith('.')) rel = './' + rel;
    return rel;
}

/**
 * Edit the extracted file:
 *   - Repoint the existing CSS-module import at the new stylesheet (moved classes).
 *   - If anything was left behind, inject a second import `<localName>Legacy`
 *     pointing at the OLD stylesheet, AND rewrite all references to left-behind
 *     classes (`s.X` → `sLegacy.X`) so they keep resolving.
 */
function updateExtractedImportsAndRefs(
    content: string,
    imp: CssImport,
    newSpec: string,
    legacySpec: string,
    leftBehindClasses: Set<string>,
): string {
    // 1. Replace import specifier.
    let next = content;
    next =
        next.slice(0, imp.specifierStart) +
        JSON.stringify(newSpec) +
        next.slice(imp.specifierEnd);

    if (leftBehindClasses.size === 0) return next;

    // 2. Inject legacy import line after the original import.
    const shift = JSON.stringify(newSpec).length - (imp.specifierEnd - imp.specifierStart);
    const importEndShifted = imp.importEnd + shift;
    const legacyLocalName = imp.localName + 'Legacy';
    const legacyLine = `\nimport ${legacyLocalName} from ${JSON.stringify(legacySpec)};`;
    next = next.slice(0, importEndShifted) + legacyLine + next.slice(importEndShifted);

    // 3. Rewrite `<localName>.<X>` → `<legacyLocalName>.<X>` for left-behind classes.
    //    Walk the updated AST so we don't accidentally touch strings/comments.
    const sf = ts.createSourceFile('tmp.tsx', next, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const edits: Array<{start: number; end: number; text: string}> = [];
    const visit = (node: ts.Node) => {
        if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
            if (node.expression.text === imp.localName && leftBehindClasses.has(node.name.text)) {
                edits.push({
                    start: node.expression.getStart(sf),
                    end: node.expression.getEnd(),
                    text: legacyLocalName,
                });
            }
        } else if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression)) {
            if (
                node.expression.text === imp.localName &&
                node.argumentExpression &&
                ts.isStringLiteral(node.argumentExpression) &&
                leftBehindClasses.has(node.argumentExpression.text)
            ) {
                edits.push({
                    start: node.expression.getStart(sf),
                    end: node.expression.getEnd(),
                    text: legacyLocalName,
                });
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(sf);

    edits.sort((a, b) => b.start - a.start);
    for (const e of edits) {
        next = next.slice(0, e.start) + e.text + next.slice(e.end);
    }
    return next;
}

function escapeRe(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

