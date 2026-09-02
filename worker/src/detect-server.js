/**
 * Server-side entry point for the field detector.
 *
 * Workers code MUST import detectFields from here, never from ./detect.js
 * directly. The difference is one line of setup that the Cloudflare Workers
 * runtime cannot do for itself.
 *
 * The problem: pdf.js never parses a PDF on the calling thread. getDocument()
 * hands the bytes to a worker, and when no real Worker is available it falls
 * back to a "fake worker" that runs the same code in-process. To get that code
 * it does a DYNAMIC import of GlobalWorkerOptions.workerSrc:
 *
 *     const worker = await import(this.workerSrc);   // pdf.mjs, PDFWorker
 *
 * In the Workers runtime `isNodeJS` is true (nodejs_compat defines a real
 * `process`), so pdf.js defaults workerSrc to the relative string
 * "./pdf.worker.mjs". A dynamic import of a runtime string is invisible to
 * esbuild, so wrangler never bundles that module, and every detection in
 * production failed with:
 *
 *     Setting up fake worker failed: "No such module "pdf.worker.mjs"."
 *
 * Node was fine, which is why every test passed: there the specifier resolves
 * against pdf.mjs's own URL and finds the file on disk. Nothing on the server
 * had ever detected a field.
 *
 * The fix: pdf.js checks one escape hatch before it reaches for the dynamic
 * import (PDFWorker._setupFakeWorkerGlobal):
 *
 *     if (globalThis.pdfjsWorker?.WorkerMessageHandler) return it;
 *
 * and the worker bundle fills that slot itself, on its own top line:
 *
 *     var __webpack_exports__ = globalThis.pdfjsWorker = {};   // pdf.worker.mjs
 *
 * So importing the module STATICALLY is the entire fix. esbuild can see a
 * static specifier, so wrangler bundles it; evaluating it publishes the
 * handler; and the dynamic import is never reached. Nothing here has to
 * arrange that by hand.
 *
 * Why this is a separate module rather than two lines in detect.js:
 * scripts/build-web.js copies worker/src/detect.js verbatim to
 * dist/preview/detect.js, where the browser resolves its bare pdfjs specifier
 * through an importmap. A worker import in that file would (a) be an unmapped
 * specifier and break the preview page outright, and (b) if mapped, replace
 * the browser's real off-main-thread Worker with the in-process fake one and
 * freeze the UI during every parse. detect.js stays runtime-neutral.
 *
 * We use the minified worker build deliberately: the note above the import
 * below records the measured sizes behind that choice.
 */

// The .min build, not the full one. Both export the same WorkerMessageHandler
// and both are pdfjs 4.0.379. Measured with `wrangler deploy --dry-run` on
// 2026-09-01, the whole Worker bundle comes to:
//
//   no worker bundled   2444 KiB raw /  528 KiB gzip   (detection was broken)
//   pdf.worker.min.mjs  4104 KiB raw /  876 KiB gzip   <- what we ship
//   pdf.worker.mjs      4587 KiB raw /  920 KiB gzip
//
// So minifying buys 484 KiB raw but only 44 KiB gzipped, since gzip already
// squeezes out most of what minification removes. Both would deploy today.
// We take the min build anyway for the headroom: this bundle is now dominated
// by two copies of pdf.js and has far less room to grow than it looks.
// scripts/check-integrity.mjs asserts the specifier so a future edit cannot
// quietly swap in the larger build.
import { WorkerMessageHandler } from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs';
import { detectFields as detectFieldsImpl } from './detect.js';

// This line is NOT what makes detection work: importing the module above
// already published globalThis.pdfjsWorker. It does two smaller jobs.
//
// 1. It is the only thing that USES the imported binding. A static import
//    whose binding is never referenced is exactly the shape a bundler is
//    entitled to drop, and dropping it silently restores the original bug.
//    Referencing WorkerMessageHandler makes the import unremovable.
// 2. ||= leaves any existing handler alone, so this is inert wherever pdf.js
//    has already wired itself up, and a backstop if a future pdfjs release
//    stops self-publishing.
//
// Placement still matters: pdf.js memoizes the resolved handler with shadow()
// on first access, so anything after the first getDocument() call is ignored.
// Module top level is the only safe place.
globalThis.pdfjsWorker ||= { WorkerMessageHandler };

/**
 * True when the in-process pdf.js worker is wired up and getDocument() can
 * actually parse. Exported so a failing detection can tell the caller whether
 * the engine is missing (our fault) or the document is unreadable (not our
 * fault). Those were reported identically for months.
 */
export function pdfWorkerReady() {
  return typeof globalThis.pdfjsWorker?.WorkerMessageHandler?.setup === 'function';
}

export { detectFieldsImpl as detectFields };
