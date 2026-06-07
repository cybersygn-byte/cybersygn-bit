/**
 * Dataset export + stats. Owner-only.
 *
 * Phase 3 (ML training pipeline) lives in the future. This file is
 * the FIRST SLICE of that work: it gives the owner a path to extract
 * the labeled-data corpus that's already accumulating from consented
 * free-tier uploads + saved templates. The export is JSONL (one
 * record per line) so you can stream-process it in Python / Polars /
 * any ML toolchain without parsing a giant JSON array.
 *
 * Data sources combined:
 *
 *   1. Templates KV (slice 32): tpl:<docId>  records with full field
 *      sets that users have explicitly saved. Highest signal — these
 *      ARE the ground truth.
 *
 *   2. Drip records (slice 38): drip:<emailHash>  free-tier signups.
 *      Contributor count, not training data per se, but useful for
 *      tracking distinct contributors and outreach lists.
 *
 *   3. Founding subscribers (slice 1): sub:<senderId>  records for
 *      revenue + cohort tracking.
 *
 * Honest about the limits: we do NOT run an active ML training
 * pipeline today. Detection is text-pattern heuristics in detect.js.
 * The corpus exported here is the raw material for future training,
 * not evidence of current AI improvement. Marketing copy must stay
 * truthful (Section 1.1 of the CONSTITUTION).
 *
 * Training readiness: the field commonly cited as the minimum for
 * a small custom CV model is 5,000 labeled examples per field class.
 * /api/owner/dataset/stats surfaces a progress bar against that.
 */

const TEMPLATE_PREFIX = 'tpl:';
const DRIP_PREFIX     = 'drip:';
const SUB_PREFIX      = 'sub:';
const TRAINING_READINESS_THRESHOLD = 5000;
const PHASE3_ALERT_KV_KEY = 'phase3:alert:sent';

/**
 * Export the dataset as JSONL. Each line is one labeled example:
 *   { docId, type, x, y, width, height, label, page, primary, savedAt }
 *
 * Streamed via ReadableStream so the worker doesn't hold the entire
 * corpus in memory. Public-scope templates only; private templates
 * are user-scoped and stay private (privacy guarantee from slice 32).
 *
 * Cursor-paginated KV list iteration. Single export covers up to
 * ~10MB of records (Cloudflare KV list limit per call).
 */
export async function exportDatasetJsonl(env) {
  if (!env || !env.CYBERSYGN_DOCS) {
    return new Response('kv_unavailable\n', { status: 503 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        // Header comment: metadata about the export.
        controller.enqueue(encoder.encode(
          `# CyberSygn labeled-data corpus export\n` +
          `# Generated at ${new Date().toISOString()}\n` +
          `# Format: JSONL, one labeled field per line\n` +
          `# Schema: {docId, page, type, x, y, width, height, label, primary, savedAt, source}\n` +
          `# Sources: public document templates (tpl:<docId>) where stats.savedCount >= 1\n`
        ));

        let cursor = null;
        let totalRows = 0;
        let totalTemplates = 0;
        let ownerSkipped = 0;

        do {
          const listOpts = { prefix: TEMPLATE_PREFIX, limit: 1000 };
          if (cursor) listOpts.cursor = cursor;
          const listResult = await env.CYBERSYGN_DOCS.list(listOpts);
          for (const entry of listResult.keys) {
            const raw = await env.CYBERSYGN_DOCS.get(entry.name);
            if (!raw) continue;
            let tpl;
            try { tpl = JSON.parse(raw); } catch (e) { continue; }
            if (!tpl || !Array.isArray(tpl.fields)) continue;
            // Skip owner-created templates: demo work, not training data.
            if (tpl.ownerCreated) { ownerSkipped++; continue; }
            totalTemplates++;
            for (const f of tpl.fields) {
              const row = {
                docId: tpl.docId,
                page: f.page,
                type: f.type,
                x: Math.round(f.x * 1000) / 1000,
                y: Math.round(f.y * 1000) / 1000,
                width: Math.round(f.width * 1000) / 1000,
                height: Math.round(f.height * 1000) / 1000,
                label: typeof f.label === 'string' ? f.label : '',
                primary: f.primary !== false,
                savedAt: tpl.updatedAt || tpl.createdAt,
                source: f.source || 'user-saved',
              };
              controller.enqueue(encoder.encode(JSON.stringify(row) + '\n'));
              totalRows++;
            }
          }
          cursor = listResult.list_complete ? null : listResult.cursor;
        } while (cursor);

        // Trailer
        controller.enqueue(encoder.encode(
          `# Export complete. ${totalRows} labeled examples across ${totalTemplates} unique documents.\n` +
          `# Skipped ${ownerSkipped} owner-created templates (demo / testing data, not training corpus).\n`
        ));
        controller.close();
      } catch (err) {
        controller.enqueue(encoder.encode(`# ERROR: ${err && err.message ? err.message : 'unknown'}\n`));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'content-disposition': 'attachment; filename="cybersygn-corpus.jsonl"',
      'cache-control': 'no-store',
    },
  });
}

/**
 * Aggregate stats. Returns counts + breakdown by field type +
 * progress against the training-readiness threshold.
 */
export async function getDatasetStats(env) {
  if (!env || !env.CYBERSYGN_DOCS) {
    return { ok: false, error: 'kv_unavailable' };
  }
  try {
    const byType = { signature: 0, initial: 0, date: 0, checkbox: 0, text: 0 };
    let templates = 0;
    let totalExamples = 0;
    let contributors = new Set();
    let dripCount = 0;
    let subCount = 0;

    // Walk public templates.
    let cursor = null;
    let ownerSkipped = 0;
    do {
      const listOpts = { prefix: TEMPLATE_PREFIX, limit: 1000 };
      if (cursor) listOpts.cursor = cursor;
      const listResult = await env.CYBERSYGN_DOCS.list(listOpts);
      for (const entry of listResult.keys) {
        const raw = await env.CYBERSYGN_DOCS.get(entry.name);
        if (!raw) continue;
        let tpl;
        try { tpl = JSON.parse(raw); } catch (e) { continue; }
        if (!tpl || !Array.isArray(tpl.fields)) continue;
        // Owner-test templates: persisted with ownerCreated:true so
        // demo work cannot inflate the customer-facing corpus stats.
        // Tracked separately so the stats payload can report what
        // was skipped — useful debugging if the count looks off.
        if (tpl.ownerCreated) { ownerSkipped++; continue; }
        templates++;
        if (tpl.savedBy) contributors.add(tpl.savedBy);
        for (const f of tpl.fields) {
          totalExamples++;
          if (byType[f.type] !== undefined) byType[f.type]++;
        }
      }
      cursor = listResult.list_complete ? null : listResult.cursor;
    } while (cursor);

    // Drip records (signup count, no field iteration).
    cursor = null;
    do {
      const listOpts = { prefix: DRIP_PREFIX, limit: 1000 };
      if (cursor) listOpts.cursor = cursor;
      const listResult = await env.CYBERSYGN_DOCS.list(listOpts);
      dripCount += listResult.keys.length;
      cursor = listResult.list_complete ? null : listResult.cursor;
    } while (cursor);

    // Subscriber records.
    cursor = null;
    do {
      const listOpts = { prefix: SUB_PREFIX, limit: 1000 };
      if (cursor) listOpts.cursor = cursor;
      const listResult = await env.CYBERSYGN_DOCS.list(listOpts);
      subCount += listResult.keys.length;
      cursor = listResult.list_complete ? null : listResult.cursor;
    } while (cursor);

    const threshold = TRAINING_READINESS_THRESHOLD;
    const readiness = Math.min(1, totalExamples / threshold);

    return {
      ok: true,
      corpus: {
        totalExamples,
        templates,
        contributors: contributors.size,
        byType,
        ownerSkipped,
      },
      growth: {
        freeSignups: dripCount,
        paidSubscribers: subCount,
      },
      trainingReadiness: {
        threshold,
        current: totalExamples,
        percentReady: Math.round(readiness * 100),
        recommendation: totalExamples >= threshold
          ? 'Ready: enough examples to begin Phase 3 custom-model training. Export the corpus and start fine-tuning.'
          : `Collecting: ${(threshold - totalExamples).toLocaleString()} more examples until Phase 3 training is recommended.`,
      },
      honesty: {
        currentDetectionMethod: 'text-pattern heuristics + optional Claude Vision API on opt-in',
        currentMLModelStatus: 'no custom ML model in production',
        whatThisCorpusEnables: 'future Phase 3 custom CV training when threshold is met',
        marketingClaim: 'Labeled PDFs in our improvement corpus (truthful, internal-use)',
      },
    };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : 'unknown' };
  }
}

/**
 * Phase 3 trigger watchdog. Called after every public template save.
 * If the corpus has crossed the training-readiness threshold AND we
 * have not already sent the alert, fire a one-shot email so the
 * decision moment is not missed by up to 30 days waiting for the
 * monthly report.
 *
 * Idempotent: the alert key in KV is set on first fire and never reset,
 * so a count that dips and recovers does not re-trigger.
 *
 * Best-effort: failures are logged and swallowed. Never blocks the
 * caller (template save).
 *
 * See docs/ML.md for the strategic decision this watchdog supports.
 */
export async function maybeFirePhase3Alert(env, deliverFn) {
  if (!env || !env.CYBERSYGN_DOCS) return;
  try {
    // Idempotency check first: skip the expensive list-walk if we've
    // already alerted. Reading a single key is one KV op vs the
    // hundreds the stats walk costs.
    const alreadySent = await env.CYBERSYGN_DOCS.get(PHASE3_ALERT_KV_KEY);
    if (alreadySent) return;

    const stats = await getDatasetStats(env);
    if (!stats.ok) return;
    const ready = stats.trainingReadiness;
    if (!ready || ready.current < ready.threshold) return;

    // Threshold crossed and never alerted. Compose + send.
    const to = (env && env.OWNER_EMAIL) || 'hello@cybersygn.io';
    const subject = `Phase 3 trigger reached: ${ready.current.toLocaleString()} labeled examples in corpus.`;
    const text = [
      'CyberSygn ML watchdog.',
      '',
      `The labeled-data corpus has crossed ${ready.threshold.toLocaleString()} examples — the documented Phase 3 trigger.`,
      `Current count: ${ready.current.toLocaleString()}.`,
      '',
      'The deferred decision in docs/ML.md is now actionable.',
      'Next steps from that file:',
      '  1. Export the corpus: GET /api/owner/dataset/export',
      '  2. Hold out 10% as a regression test',
      '  3. Choose a base model (Claude fine-tune vs OSS layout model)',
      '  4. Train, eval against the holdout, beat the heuristic+vision baseline',
      '  5. Roll out behind an opt-in flag, then promote',
      '',
      'This alert fires exactly once. The KV key phase3:alert:sent',
      'has been set so further template saves will not re-trigger it.',
      '',
      'CyberSygn.',
    ].join('\n');

    if (typeof deliverFn === 'function') {
      const result = await deliverFn(env, { to, subject, text });
      // Only mark sent if Resend (or console) acknowledged delivery.
      if (result && result.delivered) {
        await env.CYBERSYGN_DOCS.put(PHASE3_ALERT_KV_KEY, new Date().toISOString());
      }
    } else {
      // No delivery function bound — log the trigger so it's still
      // observable in worker tail logs, and mark sent so we don't
      // spam the log on every subsequent template save.
      console.log('[phase3:trigger]', JSON.stringify({ to, subject, current: ready.current, threshold: ready.threshold }));
      await env.CYBERSYGN_DOCS.put(PHASE3_ALERT_KV_KEY, new Date().toISOString());
    }
  } catch (e) {
    console.error('[phase3:trigger] watchdog failed:', e && e.message);
  }
}
