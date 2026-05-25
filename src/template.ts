/**
 * Minimal template engine for op destinations.
 *
 * Syntax: `{var|filter|filter:arg|...}` inside a path string. Variables:
 *   - `name`  — full filename (basename), e.g. `MessagesSection.tsx`
 *   - `stem`  — filename without extension, e.g. `MessagesSection`
 *   - `ext`   — extension including dot, e.g. `.tsx` (or empty for folders)
 *   - `parent` — name of the directory the entry sits in
 *
 * Filters (left-to-right):
 *   - `lc`             — lowercase
 *   - `uc`             — uppercase
 *   - `kebab`          — PascalCase / camelCase → kebab-case
 *   - `strip:Suffix`   — remove trailing `Suffix` if present
 *   - `stripPrefix:X`  — remove leading `X` if present
 *
 * Example:
 *   pattern: "src/features/{stem|strip:Section|kebab}/{stem|strip:Section}View.tsx"
 *   input:   "src/pages/MessagesSection.tsx"
 *   result:  "src/features/messages/MessagesView.tsx"
 */
import * as path from 'node:path';

export interface TemplateVars {
    name: string;
    stem: string;
    ext: string;
    parent: string;
}

export function deriveVars(fullEntryPath: string): TemplateVars {
    const name = path.basename(fullEntryPath);
    const ext = path.extname(name);
    const stem = ext ? name.slice(0, -ext.length) : name;
    const parent = path.basename(path.dirname(fullEntryPath));
    return {name, stem, ext, parent};
}

export function isTemplate(s: string): boolean {
    return s.includes('{') && s.includes('}');
}

export function renderTemplate(template: string, vars: TemplateVars): string {
    return template.replace(/\{([^{}]+)\}/g, (_match, body: string) => {
        const parts = body.split('|').map((p) => p.trim());
        const varName = parts[0];
        let value = readVar(varName, vars);
        for (const filter of parts.slice(1)) {
            value = applyFilter(filter, value);
        }
        return value;
    });
}

function readVar(name: string, vars: TemplateVars): string {
    // `in` traverses the prototype chain — would let `{constructor}` etc. coerce
    // into garbage. Use Object.hasOwn so only the four documented vars are valid.
    if (Object.prototype.hasOwnProperty.call(vars, name)) {
        return (vars as unknown as Record<string, string>)[name];
    }
    throw new Error(`unknown template variable: ${name}`);
}

function applyFilter(filter: string, value: string): string {
    const [name, ...argParts] = filter.split(':');
    const arg = argParts.join(':');
    switch (name) {
        case 'lc':
            return value.toLowerCase();
        case 'uc':
            return value.toUpperCase();
        case 'kebab':
            return toKebab(value);
        case 'strip':
            return value.endsWith(arg) ? value.slice(0, -arg.length) : value;
        case 'stripPrefix':
            return value.startsWith(arg) ? value.slice(arg.length) : value;
        default:
            throw new Error(`unknown filter: ${name}`);
    }
}

function toKebab(s: string): string {
    return s
        .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
        .replace(/[\s_]+/g, '-')
        .toLowerCase();
}
