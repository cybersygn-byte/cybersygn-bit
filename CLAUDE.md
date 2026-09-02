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

Most of it is self-maintaining, because it reads the code rather than a list:

- every `scripts/test-*.mjs` on disk must run in the gate
- every exported `handle*` must be referenced by another module, so a
  capability cannot exist with nothing able to reach it
- every binding declared in `wrangler.jsonc` must be used, and every
  `env.X.get(...)` style use must be declared (or listed in
  `OPTIONAL_BINDINGS` with a reason, which is a decision, not a default)
- no duplicate `method + /api/path`, since only the first arm can ever run

Each of those was verified by deliberately breaking it and watching the check
fail, not by reading it and assuming.

What is still curated: the short list of load-bearing CONSTANTS in section 6
(the Colorado threshold, pdf-lib `updateMetadata: false`, backup retention).
Those cannot be discovered, because only a human knows which literal is
load-bearing. **When you add a constant whose absence would be quiet, add it
there.**

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

## 9. A test that passes in Node says nothing about the Workers runtime

Server-side field detection never worked. Not once, for the life of the
product. pdf.js loads its parser with a DYNAMIC `import()` of a runtime
string, esbuild cannot see one, so wrangler never bundled the module and
every server detection answered `No such module "pdf.worker.mjs"`.

Node resolved that same specifier off disk, so it was green everywhere it
was measured: 120 corpus PDFs, 502 template PDFs, the fuzz harness, the
geometry suite. The public API reported it as `422 no_fields_detected`,
blaming the caller's document for a defect that was ours.

Two rules follow.

**Bundlers only see static imports.** A `import(someVariable)` inside a
dependency is invisible to the build and will be missing at runtime. When a
library reaches for a second file by name, import that file statically so
esbuild has to include it. `worker/src/detect-server.js` is the worked
example.

**Test where the code runs.** `npx wrangler dev` (workerd) and
`npx wrangler versions upload` (a preview on the real edge, no production
traffic) both exercise the actual runtime. Neither existed in the gate while
this bug shipped. For anything that touches bundling, module resolution, or a
platform API, a Node assertion is a starting point and not evidence.

And keep `worker/src/detect.js` runtime-neutral: `scripts/build-web.js`
copies it byte-for-byte into the browser bundle, so a Workers-only import
there breaks the preview page. Server-only setup goes in `detect-server.js`.
