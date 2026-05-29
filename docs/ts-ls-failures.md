# When TS LS refuses to extract

`extract` ops delegate to the TypeScript language service's "Move to a new
file" / "Move to file" refactor. When TS can't perform the refactor, the
tool reports the failure under one of three categories. This page collects
real-world patterns we've hit, and what to do about each.

> **None of the patterns below are bugs in front-renamer.** They're TS LS
> limitations. The tool surfaces them honestly instead of producing a half-
> working file. The fix is always either (a) tweak the source first so TS
> can extract, or (b) extract by hand.

---

## Category: `ts-ls-internal` (Expected symbol to be a module)

The most common one. TS LS throws an internal `Debug Failure` deep in its
refactor machinery. The same assertion fires for several unrelated source
shapes — we've only learned to recognise them empirically.

### Pattern A — many tiny components in one file

```ts
// src/components/FormLayout/FormLayout.tsx
export function FormContent(...) {...}
export function FormField(...)   {...}
export function FormGrid(...)    {...}
export function FormHint(...)    {...}
```

Trying to extract any one of `FormContent` / `FormField` / `FormGrid` /
`FormHint` fails. We don't know exactly which shared bit confuses TS LS —
likely the parallel re-exports + cross-references between the four —
but extracting them one-by-one via the TS LS refactor reliably asserts.

**Workaround.** Cut the symbol manually. Or break the file into the target
layout BEFORE running front-renamer (delete the body in place, paste into
the new file, fix imports).

### Pattern B — view component inside a container with deep alias chains

```ts
// src/features/appointments/AppointmentDialog/AppointmentDialog.tsx
//   20+ `@/`-aliased imports
//   useSuspenseAppointmentTypes, useCreateAppointment, ...
//   Radix/Sheet/Form slots in JSX
export function AppointmentSheetBody(...) {...}
```

Same `Expected symbol to be a module` assertion. We saw it on every "extract
body component out of a dialog/panel" attempt in the amiro batch.

**Workaround.** Manually move the body. Don't try to extract piecewise.

### Pattern C — row component inside a table component

```ts
// src/features/sales/SalesView/SalesEventsTable/SalesEventsTable.tsx
export function SalesEventsTable(...) {
    return <Table>{rows.map((r) => <SalesEventsTableRow row={r} />)}</Table>;
}
function SalesEventsTableRow(...) {...}  // local
```

Extracting `SalesEventsTableRow` fails. Same assertion.

**Workaround.** Same — extract manually.

---

## Category: `ts-ls-no-edits-move-to-file`

TS LS accepts the refactor request but returns ZERO edits. This happens
on "Move to file" (intoExisting) when the target file already imports
something that creates an ambiguity TS can't resolve.

### Pattern — intoExisting target imports a type or alias

```ts
// helpers.ts already contains:
import type {SomeType} from './shared';
export function existingHelper() {...}

// now extracting `formatX` (which uses SomeType too) → 0 edits.
```

**Workaround.** Extract `formatX` to a DISTINCT file (`formatX.ts` instead
of `helpers.ts`), or extract it manually.

---

## Category: `ts-ls-declined-move-to-new-file`

TS LS won't accept the refactor at all. Two empirical triggers:

### Pattern A — single-statement file

```ts
// src/foo.ts
export const PI = 3.14;
```

`extract PI from src/foo.ts` is refused. TS LS only offers
"Move to a new file" when there are multiple top-level statements.

**Workaround.** None needed — the symbol is already the file's only
content. Just `mv` the file.

### Pattern B — non-exported symbol

```ts
// not exported
const helper = () => 1;
export function publicThing() {return helper();}
```

`extract helper` is refused. Make it `export const helper` first, OR
extract `publicThing` and let the move drag `helper` along (TS LS does
this automatically for the new file case).

---

## What we don't yet have a fix for

- **Diagnostic clarity from the assertion itself.** TS LS doesn't tell us
  WHICH import / WHICH cross-ref hit the assert. The message is identical
  across all of Pattern A/B/C above. We surface counts (top-level
  statements, alias imports, etc.) in the failure context, but that's
  triage info, not a root cause.
- **Auto-recovery.** We considered "if extract fails, try with target
  file written to disk first" — but the assertion happens BEFORE TS
  inspects the target, so disk presence doesn't help.

If you hit a pattern that isn't listed here, open an issue with the source
file and the failing op — we'll add it.
