# front-renamer

**Restructure your React/TypeScript codebase in seconds, not days.**

Declare where every file should live, run one command, ship a clean tree —
imports rewritten, identifiers renamed, history preserved.

```bash
npx front-renamer ops.json --apply
```

---

## The problem

Your folder structure stopped scaling six months ago. You know exactly how it
should look. But getting there means:

- moving **hundreds of files** across the repo
- updating **thousands of imports** in lockstep
- renaming components and their props/hooks/helpers consistently
- keeping `git log --follow` intact so history doesn't die
- doing all of it without breaking TypeScript for a single commit in between

That's a one-to-three-day project for a senior engineer. So the structure stays
broken. New code piles on top of the bad layout. The cost compounds.

IDE rename works one symbol at a time. Find-and-replace ruins your imports.
`ts-morph` lets you script it — but only after you become a ts-morph expert.
None of these scale to "rearrange the whole repo this afternoon."

## What front-renamer does

You write a JSON file that says **what should be where**:

```json
[
  ["src/components/Dashboard", "src/features/dashboard/DashboardView"],
  ["src/components/UserSettings", "src/features/users/UserSettings"],
  ["src/components/Button", "src/components/ui/Button"],
  ["src/components/Spinner.tsx", "src/components/ui/Loader.tsx"]
]
```

Run it:

```bash
npx front-renamer ops.json --apply
```

Done. The tool:

- Moves every file and folder to its new home
- Rewrites every `import` in your entire codebase — both `@/`-aliased and
  relative — to the new locations
- Renames the matching component identifier (and its `Props`, and any
  other declarations you list) across every reference in the project
- Carries sibling `.module.scss` along for the ride
- Uses `git mv` so `git log --follow` still works tomorrow
- Type-checks before AND after, refusing to run if your repo isn't already
  green, and bailing loudly if something it did breaks the build

Real-world test: **126 ops, 769 file relocations, 424 files with rewritten
imports — ~15 seconds end-to-end including two full project type-checks.**

## Why declarative

You don't have to learn an API. You don't have to write code. You don't have to
remember whether `move()` updates aliased imports (it doesn't, and that's where
the day disappears).

You describe the destination. The tool computes the path.

## Quick start

```bash
# Preview what would change — no disk writes
npx front-renamer ops.json --dry

# Apply for real
npx front-renamer ops.json --apply
```

Install as a dev dependency:

```bash
pnpm add -D front-renamer
pnpm exec front-renamer ops.json --apply
```

## Writing ops

Ops are a JSON array. Each entry is either a **short tuple** or a **full
object**. Mix them freely:

```json
[
  ["src/components/Dashboard", "src/features/dashboard/DashboardView"],

  {
    "from": "src/components/Inputs",
    "to": "src/components/forms/fields"
  },

  {
    "from": "src/components/Widget",
    "to": "src/features/widgets/Widget",
    "renameSymbols": [
      {"old": "Widget", "new": "WidgetCard"},
      {"old": "WidgetProps", "new": "WidgetCardProps"},
      {"old": "useWidget", "new": "useWidgetCard"}
    ]
  }
]
```

### How rename detection works

When you write a tuple or a full object **without** `renameSymbols`, the tool
checks: did the basename change? If yes and the file (or main `<basename>.tsx`
inside a folder) exists, it renames that identifier and its references for free.

When you need finer control — multiple identifiers in one file, or a rename
that the basename can't express — list them explicitly under `renameSymbols`.

Pass `"renameSymbols": []` to suppress autodetection.

### Path conventions

- Paths are relative to the project root (or `--cwd <path>`).
- Extension on the path means **file**. No extension means **folder**.

## CLI

```
front-renamer <ops.json> [options]

  --apply              Commit changes to disk (default is dry-run).
  --dry                Force dry-run (default).
  --cwd <path>         Project root. Default: current working directory.
  --tsconfig <path>    tsconfig file. Default: autodetect tsconfig.app.json
                       → tsconfig.json.
  --src <path>         Source directory to scan. Default: <cwd>/src.
  --skip-typecheck     Skip pre-/post-typecheck (faster, less safe).
  --quiet              Reduce output to errors and final status.
  -h, --help           Show this help.
```

## What it handles

- **Folder moves** with arbitrary depth — children, grandchildren, sibling
  styles, everything follows.
- **Folder renames** in place (`PatientRecord` → `PatientRecordView`).
- **File moves** — wrap a loose file into its own folder, drop it into a
  shared `helpers/` dir, anything.
- **Identifier renames** across the entire project via the TypeScript
  language service. Default-import local bindings get rebound too.
- **Sibling assets** — `.module.scss` / `.module.css` next to a `.tsx`
  travel with it automatically.
- **Aliased imports** (`@/components/Foo`) — resolved via `tsconfig.paths`
  and rewritten alongside relative imports.
- **Chains** — `A → B`, then later `B → C` somewhere else in the same ops
  file. The tool builds a dependency graph and applies in the right order.
- **Random input order** — your ops don't need to be sorted. The planner
  topologically sorts them and reports parallel-safe phases.

## What it doesn't do

This is a structural tool, not a codemod. It deliberately stays out of code
semantics.

- **It doesn't decide the structure for you.** You declare the destination.
  The tool applies it.
- **It doesn't transform code.** No "convert all class components to hooks",
  no "swap library A for library B". If you want jscodeshift-style rewrites,
  run them separately.
- **It doesn't split or merge files.** Files move as units. Extracting one
  export into a new file, or combining two files into one — out of scope.
- **It doesn't touch strings, comments, or JSX text.** `"OldName"` written as
  a string literal stays a string literal. Same for log messages, docs,
  comments mentioning old names.
- **It doesn't run formatters.** Run Prettier, ESLint, oxlint, etc.
  separately after `--apply` if your team cares about quote style or
  whitespace conventions.
- **It doesn't update external config files.** `knip.json`, ESLint configs,
  Vite aliases, `package.json` scripts that hardcode old paths — those are
  yours to update. Only `tsconfig.paths` is read (to resolve `@/`-style
  aliases).
- **It doesn't commit to git.** It uses `git mv` for relocations so history
  is preserved, but writing the commit (and its message) is your job.
- **It doesn't rollback on failure.** If post-typecheck fails, changes stay
  on disk for inspection. Use `git restore .` to abandon, or fix forward.
- **It doesn't resolve dynamic imports.** `import(someVariable)` and
  `require(someExpr)` are invisible — only string-literal specifiers get
  rewritten.
- **It doesn't work without TypeScript.** A `tsconfig.json` (or
  `tsconfig.app.json`) is required. JS-only repos aren't supported.
- **It doesn't rename non-exported locals.** Identifier renames target
  declarations referenced across files. A function-local variable named the
  same as your component stays untouched (which is what you want).
- **It doesn't move non-TS assets except sibling styles.** `.module.scss` and
  `.module.css` next to a `.tsx` follow automatically. Everything else
  (images, JSON fixtures, MDX, etc.) needs an explicit op.

## Safety

- **Pre-typecheck**: refuses to run if your project already has TS errors
  (so post-typecheck failures are clearly attributable to the refactor).
- **Dry-run by default**: nothing touches disk until you pass `--apply`.
- **Post-typecheck**: full TS pass after commit. Non-zero exit if anything
  broke, with the changes preserved on disk for inspection.
- **`git mv`**: real moves, not delete+add. `git log --follow` survives.

## Programmatic use

```ts
import {loadProject, normalizeOps, buildPlan, Engine} from 'front-renamer';

const project = loadProject(process.cwd());
const ops = normalizeOps(
    [
        ['src/components/Foo', 'src/features/foo/Foo'],
    ],
    project.root,
);
const plan = buildPlan(ops);
const engine = new Engine(project);
engine.applyToVFS(plan.levels);
engine.rewriteAllImports();
engine.commit();
```

## License

MIT.
