// lib/models.js — sanitize the providers payload (strip secrets) and order models.

const ALLOWED_PROVIDERS = new Set(['chutes', 'openrouter', 'abliteration', 'cavoti']);

// Preferred order for the `featured` list. Each entry is [providerID, modelID].
const PREFERRED = [
  ['chutes', 'moonshotai/Kimi-K3-TEE'],
  ['abliteration', 'abliterated-model-large-v2'],
  ['openrouter', 'nex-agi/nex-n2.5-pro:free'],
  ['openrouter', 'z-ai/glm-5.3-flash'],
  ['cavoti', 'glm-5.3-flash'],
  ['openrouter', 'deepseek/deepseek-v4.1-flash'],
  ['openrouter', 'openai/gpt-5.6-luna'],
  ['chutes', 'zai-org/GLM-5.2-TEE'],
];

/**
 * Sanitize the raw `/config/providers` payload into a list of models containing
 * only {providerID, providerName, modelID, modelName}. Never leaks key/apiKey/headers.
 *
 * The upstream shape (from samples/openapi.json) is assumed to be:
 * {
 *   "chutes": { "id":"chutes", "name":"Chutes", "models":[ {id, name}, ... ] },
 *   ...
 * }
 * But we also tolerate a bare array, or an array of {providerID,...} objects,
 * and a top-level object whose values are provider objects.
 * @param {unknown} data
 * @returns {{providerID: string, providerName: string, modelID: string, modelName: string}[]}
 */
export function sanitizeModels(data) {
  const out = [];
  const seen = new Set();
  const push = (providerID, providerName, modelID, modelName) => {
    if (!ALLOWED_PROVIDERS.has(providerID)) return;
    if (!modelID || typeof modelID !== 'string') return;
    const key = `${providerID}/${modelID}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      providerID,
      providerName: providerName || providerID,
      modelID,
      modelName: modelName || modelID,
    });
  };

  if (Array.isArray(data)) {
    for (const p of data) {
      const pid = pick(p, ['providerID', 'id', 'provider']);
      const pname = pick(p, ['providerName', 'name']) || pid;
      for (const m of pick(p, ['models', 'model']) || []) {
        push(String(pid), String(pname), String(m.id || m.name), String(m.name || m.id));
      }
    }
    return out;
  }

  if (data && typeof data === 'object') {
    // Real opencode 1.18.18 shape: {providers:[{id, name, key, options, models:{<modelID>:{id, name, ...}}}], default:{...}}
    if (Array.isArray(data.providers)) {
      for (const p of data.providers) {
        if (!p || typeof p !== 'object') continue;
        const pid = String(p.id);
        const pname = String(p.name || pid);
        for (const [mid, m] of modelEntries(p.models)) {
          push(pid, pname, String((m && m.id) || mid), String((m && m.name) || mid));
        }
      }
      return out;
    }
    // Fallback: a map providerID -> {name, models}
    for (const [pid, val] of Object.entries(data)) {
      if (!val || typeof val !== 'object') continue;
      const pname = val.providerName || val.name || pid;
      for (const [mid, m] of modelEntries(val.models)) {
        push(String(pid), String(pname), String((m && m.id) || mid), String((m && m.name) || mid));
      }
    }
  }
  return out;
}

// `models` is a map {modelID: {...}} upstream, but tolerate an array of {id, name}.
function modelEntries(models) {
  if (Array.isArray(models)) return models.map((m) => [m && (m.id || m.name), m]);
  if (models && typeof models === 'object') return Object.entries(models);
  return [];
}

function pick(o, keys) {
  if (!o || typeof o !== 'object') return undefined;
  for (const k of keys) if (o[k] !== undefined) return o[k];
  return undefined;
}

/**
 * Split a sanitized model list into {featured, more}:
 * - featured: the PREFERRED list (only those actually present), in preferred order.
 * - more: every other allowed model, sorted by provider then name.
 * @param {object[]} models sanitized [{providerID, providerName, modelID, modelName}]
 */
export function splitFeatured(models) {
  const byKey = new Map(models.map((m) => [`${m.providerID}/${m.modelID}`, m]));
  const featured = [];
  for (const [pid, mid] of PREFERRED) {
    const m = byKey.get(`${pid}/${mid}`);
    if (m) featured.push(m);
  }
  // OpenRouter's auto-detected catalog is ~375 models including expensive paid ones
  // (Opus, o1-pro, ...); a mis-tap on a phone would spend real credit. Beyond the
  // featured list, only offer OpenRouter's :free models. Chutes is free for us.
  const more = models
    .filter((m) => !featured.includes(m))
    .filter((m) => m.providerID !== 'openrouter' || m.modelID.endsWith(':free'))
    .sort((a, b) => (a.providerID < b.providerID ? -1 : a.providerID > b.providerID ? 1 : a.modelName < b.modelName ? -1 : 1));
  return { featured, more };
}

/**
 * Confirm the sanitized output never contains a secret value.
 * Used by the unit test to guard against leaking provider keys.
 */
export function leaksSecret(sanitized, sampleValue) {
  const blob = JSON.stringify(sanitized);
  return blob.includes(sampleValue) || /"key"|"apiKey"|"headers"|"Authorization"/.test(blob);
}