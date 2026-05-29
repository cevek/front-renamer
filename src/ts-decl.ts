/**
 * Top-level declaration lookup — find a named declaration in a source file's
 * IMMEDIATE children (no nested scope walk). Returns BOTH the identifier
 * position (for rename anchoring) and the enclosing statement (for extract
 * range selection) in one pass.
 *
 * Previously this lived in two places — `rename.ts` (full set: function /
 * class / interface / type-alias / **enum / module** / variable) and
 * `extract.ts` (same MINUS enum/module) → extract silently couldn't find
 * `enum X` or `namespace Y` exports. Sharing here fixes the feature gap and
 * removes drift risk for future declaration kinds (variable-as-arrow, etc.).
 */
import {ts} from './ts-loader.js';

export interface DeclarationHit {
    /** Position of the identifier (e.g. `X` in `function X() {}`). */
    pos: number;
    /** The enclosing top-level statement (whole `function …` block). */
    statement: ts.Statement;
}

export function findTopLevelDeclaration(sf: ts.SourceFile, name: string): DeclarationHit | null {
    for (const stmt of sf.statements) {
        if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === name) {
            return {pos: stmt.name.getStart(sf), statement: stmt};
        }
        if (ts.isClassDeclaration(stmt) && stmt.name?.text === name) {
            return {pos: stmt.name.getStart(sf), statement: stmt};
        }
        if (ts.isInterfaceDeclaration(stmt) && stmt.name.text === name) {
            return {pos: stmt.name.getStart(sf), statement: stmt};
        }
        if (ts.isTypeAliasDeclaration(stmt) && stmt.name.text === name) {
            return {pos: stmt.name.getStart(sf), statement: stmt};
        }
        if (ts.isEnumDeclaration(stmt) && stmt.name.text === name) {
            return {pos: stmt.name.getStart(sf), statement: stmt};
        }
        if (
            ts.isModuleDeclaration(stmt) &&
            ts.isIdentifier(stmt.name) &&
            stmt.name.text === name
        ) {
            return {pos: stmt.name.getStart(sf), statement: stmt};
        }
        if (ts.isVariableStatement(stmt)) {
            for (const decl of stmt.declarationList.declarations) {
                if (ts.isIdentifier(decl.name) && decl.name.text === name) {
                    return {pos: decl.name.getStart(sf), statement: stmt};
                }
            }
        }
    }
    return null;
}
