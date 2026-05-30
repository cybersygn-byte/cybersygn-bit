/**
 * CyberSygn storage abstraction.
 *
 * In production this wraps Cloudflare KV namespaces declared in
 * wrangler.toml. In local dev (no bindings configured), an in-memory
 * Map fallback keeps the API surface identical so the rest of the
 * Worker code does not care which backend it is talking to.
 *
 * Two namespaces are used:
 *   CYBERSYGN_DOCS  | document metadata (signers, fields, assignments, fills)
 *   CYBERSYGN_PDFS  | original PDF bytes, keyed by doc id
 *
 * KV value size limit is 25 MB, which matches our request-body ceiling.
 * R2 is the right backend for production at scale, but KV is sufficient
 * for the founding-member launch volume.
 */

// Process-lifetime in-memory store. Reset whenever wrangler dev restarts.
// Used only when KV bindings are not configured.
const memoryDocs = new Map();
const memoryPdfs = new Map();

export function getStorage(env) {
  const docsBinding = env && env.CYBERSYGN_DOCS;
  const pdfsBinding = env && env.CYBERSYGN_PDFS;
  const docs = docsBinding ? kvBackend(docsBinding) : memoryBackend(memoryDocs);
  const pdfs = pdfsBinding ? kvBackend(pdfsBinding) : memoryBackend(memoryPdfs);
  return {
    docs,
    pdfs,
    mode: docsBinding ? 'kv' : 'memory',
  };
}

function kvBackend(ns) {
  return {
    async get(key, { json = false, arrayBuffer = false } = {}) {
      if (json) return ns.get(key, 'json');
      if (arrayBuffer) return ns.get(key, 'arrayBuffer');
      return ns.get(key);
    },
    async put(key, value, opts = {}) {
      // Cloudflare KV accepts strings, ArrayBuffers, or ReadableStreams.
      const payload = (value && typeof value === 'object' && !(value instanceof ArrayBuffer))
        ? JSON.stringify(value)
        : value;
      return ns.put(key, payload, opts);
    },
    async delete(key) { return ns.delete(key); },
  };
}

function memoryBackend(map) {
  return {
    async get(key, { json = false, arrayBuffer = false } = {}) {
      const v = map.get(key);
      if (v == null) return null;
      if (json && typeof v === 'string') return JSON.parse(v);
      if (arrayBuffer && v instanceof ArrayBuffer) return v;
      return v;
    },
    async put(key, value) {
      map.set(key, value);
    },
    async delete(key) {
      map.delete(key);
    },
  };
}
