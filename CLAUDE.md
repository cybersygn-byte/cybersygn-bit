# CyberSygn: working rules

Read this before editing. Every rule here exists because ignoring it already
cost real work or shipped a real defect.

## 1. Agents that write files MUST get `isolation: 'worktree'`

Twelve concurrent Claude processes once shared this single checkout. No
subagent was isolated, so every one of them edited the same working tree as
the orchestrator. One ran a git-hygiene routine and the tree was wiped three
times. The reflog signature is a stash named `agent-wip-*`, a branch commit
labelled `UNREVIEWED AGENT WORK`, then `reset: moving to HEAD`.

Two `package.json` edits were lost. One failed loudly and got fixed. The other,
a test suite dropped from the gate, failed **silently** and would have stayed
green forever.

So: any subagent that writes files gets `isolation: 'worktree'`. If you cannot
isolate, commit after every single edit rather than batching.

## 2. A test that does not run is worse than no test

It looks like coverage. Nine suites were once on disk and wired to nothing,
including the regression guard for a subscription-entitlement bug that was
actively broken at the time.

`npm run check:integrity` asserts the wiring itself: every `scripts/test-*.mjs`
runs in the gate, every script the gate calls exists, every capability is
routed, every binding is declared, and load-bearing constants are present.

**When you add a capability whose ABSENCE would be quiet, add a check there.**
The "every test runs" half is self-maintaining because it discovers files. The
route, binding, and constant lists are curated, so they only cover what someone
remembered to add. That is a real limit; treat the file as a living checklist.

## 3. One gate, shared by CI and deploy

`npm run verify` is the gate. `deploy` is `verify && wrangler deploy`, and CI
runs `verify`. They cannot drift, and `check:integrity` enforces that they do
not. Never hand-list steps in `.github/workflows/ci.yml` again: CI once ran 4
steps while deploy ran 19.

## 4. Commit is not deploy

`web/dist` is gitignored and CI has no deploy step. Committing changes nothing
in production. Run `npm run deploy`.

## 5. A page in source that never reaches dist is a 404 nobody sees

This shipped twice: `/erase/`, which the privacy policy linked to, and the
`/use-cases/` hubs, which orphaned all 48 landing pages. Both were found in
production, one by curl and one by Search Console.
`npm run check:dist` now fails the build instead.

## 6. Honesty rails

No fabricated counts, testimonials, or capabilities. Copy must be true against
the code on the day it ships. Several times a page has claimed something the
engine did not do yet: a QR code that existed nowhere, a signed PDF issued to
every party before the flatten engine existed, "no backup archive" after one
was bound. Verify the claim in the code before you write the sentence.

## 7. No em-dashes

Anywhere. Not in code, comments, copy, docs, or commit messages. Use commas,
colons, periods, or parentheses. `npm run lint:emdash` checks it.

## 8. CSP is hash-based, with no `unsafe-inline`

Most JS is external, but several pages carry hashed inline scripts:
`web/index.html` has 5, `web/templates/index.html` has 1, and `web/_headers`
holds 23 hashes. Editing ANY inline script means recomputing its sha256 and
updating `web/_headers`, or that page silently breaks under CSP.
