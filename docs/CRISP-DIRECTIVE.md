# CyberSygn Crisp: the product UX directive

Date: 2026-07-05. Owner: Nathan. Status: canon for /dashboard/ and /preview/.

## Why

The tool grew one slice at a time until the dashboard renders ~10,400px of
stacked panels (13 screens) for a logged-in user, five configuration panels
compete with the documents list, and every card carries three typefaces at
once (mono uppercase kicker + serif or display title + sans body). It reads
as an engineering console. Users feel crowded and lost.

## North star

Apple-clean, in CyberSygn's own navy/cyan skin, executed the way the Violet
ecosystem does it: the tool is a crafted professional instrument, not a
cockpit. One screen has one job. Everything else waits quietly behind a
disclosure until asked for.

## The five laws

1. ONE JOB PER SCREEN. The dashboard's job: see your documents, send a new
   one. The preview tool's job at any moment is exactly one of: get a file
   in, review the fields, sign, or send. Whatever does not serve the current
   job is folded or gone.

2. PROGRESSIVE DISCLOSURE, NOT STACKING. Configuration (identity, branding,
   webhooks, affiliate, Origin card, workspace) lives in ONE "Account and
   settings" group of collapsed rows. Each row = plain-language name + one
   line of what it does + chevron. Expanding one row never pushes the
   documents list off screen by default.

3. TYPE DISCIPLINE (the Violet rule).
   - Sans (Inter) for everything by default.
   - Mono (JetBrains) ONLY for data the user might copy or compare: ids,
     keys, counts, dates, file names. Never for labels or headings.
   - Serif (Fraunces) ONLY for the single page title, nowhere else in the
     tools. Modals use sans.
   - Kickers: demoted. No mono-uppercase-letterspaced kicker rows inside the
     tools. Section names are just calm sans semibold, sentence case.

4. PLAIN LANGUAGE, USER VALUE FIRST. Every heading says what the user GETS,
   not what the system is. "Outbound webhooks." becomes "Notify your other
   tools". "Sender identity" becomes "How you appear to signers".
   No trailing periods on headings inside the tools. No jargon (webhook,
   payload, senderId) in a summary row; jargon may appear only inside an
   expanded technical section.

5. CALM SURFACES. One border, not three. Fewer boxes: group with whitespace
   first, hairline second, card only when it is an actual object (a
   document, a signer). Radius 12-16. No decorative dashes/brackets in the
   tools. Motion: 150-200ms ease-out only on state change, nothing ambient.

## Dashboard information architecture (top to bottom)

1. Header: page title + ONE primary button ("Send a document").
2. Your documents (the table/list), the whole screen for returning users.
   Empty state = the 3-step checklist (already good, keep, restyle).
3. "Account and settings", collapsed rows, in this order:
   how you appear to signers (identity), brand your signing pages (brand),
   your plan and usage (stats + upgrade), invite and earn (affiliate),
   notify your other tools (webhooks), workspace members, Origin wall card
   (only when member).
4. Owner-only panel stays but is folded by the same pattern.

Nothing in the settings group renders expanded on load. State (open row)
may persist per user via localStorage.

## Preview tool staging

- Stage titles in the sidebar top: what to do NOW, one sentence.
- Legend chips: only after a doc loads, single quiet row (keep).
- Tools & templates: stays a collapsed details (keep pattern, restyle).
- Signers panel: keep; "Signing as" only with 2+ signers (already handled).
- Field list: cap visible height with internal scroll so the sidebar never
  exceeds the viewport.

## JS contract

Every id and data-attribute the JS reads is preserved. Restructure = move,
wrap, and restyle; never rename ids. Hidden-by-default sections still exist
in the DOM so app code that unhides them keeps working.

## What we do NOT do

- No framework, no build-step change, no renaming of files.
- No feature removal: everything reachable before is reachable after,
  at most one click deeper, always with a clearer name.
- Marketing pages keep their voice; this directive governs the TOOLS
  (/dashboard/, /preview/, bulk-send) plus shared modal styling.

## Appendix: Violet "Quiet Authority" values we port (colors swapped to navy/cyan)

- Surfaces separated by 1px hairlines, never heavy borders. Cards only for real objects.
- Section header = sentence-case sans, 15px/600, -0.005em, hairline rule under (`.crisp-sub`).
- Eyebrow/kicker demoted: no mono-uppercase-tracked kickers inside the tools.
- Mono ONLY for data (ids, keys, counts, dates, filenames) with tabular-nums.
- Serif (Fraunces) only for the single page title.
- Headings weight 500-600, never 700; contrast via size+color, not weight.
- Radii: sm 4 / base 8 / lg 14 / xl 20 / pill 999 (existing tokens).
- One motion: ~180ms ease-out on state change; overlays may go 240ms.
- Progressive disclosure via native `<details>`: secondary tools default-collapsed,
  the one primary section open. Summary reuses the section-header treatment + a
  chevron that rotates 90deg on open.
- Overflow actions collapse into a single "More" popover, not a button row.
- Status colors encode state only, never decorate.
