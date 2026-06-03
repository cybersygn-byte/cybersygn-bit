# Phase 3 ML — strategic deferral, with explicit trigger

This document is the official record of the CyberSygn ML decision. If you (or a future AI session) are wondering "should we build the ML pipeline now?", the answer is below.

## Decision

**Defer the Phase 3 custom CV model until the labeled-data corpus reaches 5,000 examples.**

Until that threshold is crossed, the production detection stack stays exactly what it is today:

1. **Heuristic detection** (`worker/src/detect.js`): text-pattern signature-line detection. 37 of 37 real-world PDFs at 100%, 10 of 10 synthetic at 100%.
2. **Claude Vision API** (`worker/src/vision.js`): opt-in escalation for hard pages. ~$0.01 per page, per-sender monthly cap, off by default.

These two together cover the cases we see today. Adding a custom CV model on top would be slower to ship, more expensive to operate, and harder to debug — for marginal accuracy gain we can't yet measure.

## Why 5,000 examples

It's the threshold where supervised fine-tuning of a vision-language model starts to outperform a hand-tuned heuristic + foundation-model fallback. Below that, the model overfits to whichever PDFs happened to enter the corpus first. Above that, the per-call cost and latency of a fine-tuned model become competitive with what we're paying Claude.

The number isn't arbitrary — it's the floor at which the math shifts. Below 5k, the right answer is "keep paying for vision." Above 5k, the right answer is "train and serve our own."

## How we know when we hit it

Three independent signals:

1. **Monthly owner report email** (first of every month, 00:00 UTC). The training-readiness section reports `current / threshold` and the `recommendation` field flips from "Collecting" to "Ready" the first time corpus crosses 5,000.

2. **GET /api/owner/dataset/stats** (any time, owner token required). Returns the same `trainingReadiness` payload as the monthly report.

3. **Threshold-crossed alert** (one-shot). When the corpus crosses the threshold mid-month — even just once — a dedicated email fires immediately so we don't miss the moment by waiting for the next report. The alert is idempotent: once sent, it does not re-fire even if the count dips and recovers.

## What we do when the trigger fires

1. **Export the corpus**: `curl -H "X-CyberSygn-Owner: <token>" https://cybersygn.io/api/owner/dataset/export > corpus.jsonl`. This streams every labeled field position from every public template as JSONL.

2. **Hold-out split**: pull 10% of the corpus as a regression-test holdout. Never train on this. The current heuristic+vision stack is also evaluated against it so we have a baseline to beat.

3. **Pick a base model**. Candidates as of this writing: Claude Vision (already integrated, could be fine-tuned through the API if Anthropic exposes that path), or an open-source model (LayoutLMv3, DocFormer, Donut) trained from scratch or fine-tuned from a checkpoint. The choice depends on whether Anthropic's fine-tune API is available and how the cost compares.

4. **Build the training pipeline**. Conventional ML iteration loop: train → eval against holdout → if accuracy < heuristic+vision baseline, stop and rethink; if accuracy > baseline by a meaningful margin, ship behind a feature flag.

5. **Roll out gradually**. Behind a per-sender opt-in flag for the first month so we can A/B against the existing stack on live PDFs. Promote to default only after the model beats the baseline in production over a full week.

6. **Keep the heuristic and vision as fallback**. Never ship the ML model as the sole detection path. If it ever returns zero fields where the heuristic would have returned non-zero, the heuristic result wins.

## What would change this plan

The deferral is conditional. If any of these hit, revisit before the 5k trigger:

- **Vision cost exceeds $X/month sustainably**. If per-sender vision spend balloons, training our own becomes the cheaper option earlier than corpus growth predicts.
- **Heuristic breaks on a meaningful class of documents**. If a customer cohort (e.g. a specific contract template format) consistently produces zero fields, the right answer might be tuning the heuristic for that format, not waiting on ML.
- **A faster path emerges**. Better base models, cheaper fine-tuning APIs, anything that makes the trade-off different.

## What this means for the present

- **Stop debating ML in chat**. The decision is documented. Future asks of "should we build the model?" route to this file.
- **Marketing copy stays honest**: "text-pattern heuristics + Claude Vision on opt-in" — exactly what we ship today. No claims of custom ML.
- **The dataset endpoint stays maintained**: `/api/owner/dataset/export` is the eventual training input, not a dead feature.

CONSTITUTION 1.3 ("push back when scope is wrong") and 1.7 ("truth before completion") both honored: we're not building infrastructure we can't use, and we're not claiming capability we don't have.

## Trigger status (auto-updated)

| Field | Value | Source |
|---|---|---|
| Threshold | 5,000 examples | `worker/src/dataset.js` `TRAINING_READINESS_THRESHOLD` |
| Current count | check `/api/owner/dataset/stats` | live |
| Recommendation copy | "Collecting" or "Ready" | live |
| Last threshold-crossed alert | (never sent, or KV key `phase3:alert:sent`) | live |

To check the current state without the dashboard:

```
curl -H "X-CyberSygn-Owner: <token>" https://cybersygn.io/api/owner/dataset/stats | jq '.trainingReadiness'
```
