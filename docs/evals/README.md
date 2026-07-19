# CyberSygn AI co-pilot evals

Faithfulness-first eval set for the two AI surfaces of the co-pilot: contract
**drafting** (`/draft/`) and completed-document **summaries**. This product
handles legal documents, so a hallucinated clause or an unfaithful summary is a
real-world harm. The checks weight faithfulness (no invented legal specifics, no
fabricated values), refusal on clearly unlawful requests, resistance to prompt
injection inside user briefs, and cost-control adherence.

## Files

- `PROMPTS.md` - the live system prompts, input fences, output parsing, and cost
  controls with `file:line` references, plus a changelog. Read this first.
- `cases/golden.jsonl` - representative realistic inputs with expected properties.
- `cases/adversarial.jsonl` - prompt-injection attempts embedded in user content,
  fabrication temptations, clearly unlawful requests, and hostile formatting.
- `cases/regression.jsonl` - past known failure modes (markdown fences, preamble,
  "legally binding" notes, the max_tokens cost regression, faithfulness on sparse
  fills, and the pre-API input guards).
- `run-evals.mjs` - the runner. Imports the real `generateDraft` /
  `generateSummary` from `worker/src`, so it tests the actual production prompts,
  model string, token bounds, and parsing.

## What runs automatically vs. what costs money

Two things run on every `npm run lint` (and therefore every deploy), both
**offline with zero API spend**, wired through `npm run eval:check`:

- `node docs/evals/run-evals.mjs` (no `--run`): parses and validates every case
  file and imports the real `generateDraft` / `generateSummary`, so a broken
  case file or a syntax error in the production AI modules fails the gate.
- `node docs/evals/guardrails.test.mjs`: 12 deterministic assertions against the
  exported `sanitizeDraft` / `sanitizeSummary` backstops (code-fence stripping,
  preamble removal, hard length caps, refusal pass-through, null-safety).

The **live** runner (`run-evals.mjs --run`, also `npm run eval:run`) is the only
part that calls the Anthropic API and spends real money. It is never invoked by
lint, build, or deploy, and refuses to run without `ANTHROPIC_API_KEY`.

## Running

Dry run (default): validates that every case parses and prints the cost
estimate. Makes no API calls and needs no API key.

```
node docs/evals/run-evals.mjs
```

Execute against the live API (spends money, requires the key):

```
ANTHROPIC_API_KEY=sk-ant-... node docs/evals/run-evals.mjs --run
```

The runner refuses to execute without `ANTHROPIC_API_KEY`, prints the estimated
cost up front, then scores each case with cheap deterministic checks (schema
validity, required and forbidden substrings and regex, length bounds, and
refusal-when-required). No LLM judge is used by default. Exit code is 0 when all
executed cases pass, 1 otherwise.

## Case check vocabulary

Each case has an `input` (passed straight to the production function) and a
`checks` object. Supported checks:

- `expect_ok` (bool), `expect_reason` (string), `expect_title` (string) - result
  shape from the production function.
- `expect_refusal` (bool) - passes when the result is not ok, or the text carries
  a refusal. Paired with `forbidden_substrings` so a compliant harmful draft
  fails both ways.
- `min_length` / `max_length` - character bounds on the output.
- `required_regex` (all must match), `required_substrings_all` (all present),
  `required_substrings_any` (at least one present).
- `forbidden_substrings` (none present), `forbidden_regex` (none match).

Regex are compiled case-insensitively and are not multiline; patterns that need
line anchoring use an explicit `(^|\n)`.

## Cost estimate

The estimate assumes worst-case output (billed at the model `max_tokens`: 1600
for drafts, 600 for summaries) and prices the pinned `claude-sonnet-4-5` at
$3 / $15 per 1M input/output tokens. Verify against current Anthropic pricing
before trusting the absolute figure. Pre-API guard cases (too-short description,
no filled values) cost nothing and are counted separately.
