// test/models.test.js — models sanitization strips secrets + preferred order.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeModels, splitFeatured, leaksSecret } from '../lib/models.js';

const SAMPLE = {
  chutes: {
    id: 'chutes', name: 'Chutes',
    key: 'sk-TOP-SECRET',
    options: { apiKey: 'sk-OPTIONS-KEY' },
    headers: { Authorization: 'Bearer SECRET-HDR' },
    models: [
      { id: 'moonshotai/Kimi-K3-TEE', name: 'Kimi K3 TEE' },
      { id: 'zai-org/GLM-5.2-TEE', name: 'GLM 5.2 TEE' },
      { name: 'no-id' },
    ],
  },
  openrouter: {
    id: 'openrouter', name: 'OpenRouter',
    key: 'or-sk-ROUTER-KEY',
    models: [
      { id: 'nex-agi/nex-n2.5-pro:free', name: 'nex n2.5 pro' },
      { id: 'z-ai/glm-5.3-flash', name: 'glm 5.3 flash' },
      { id: 'deepseek/deepseek-v4.1-flash', name: 'deepseek v4.1 flash' },
      { id: 'openai/gpt-5.6-luna', name: 'gpt 5.6 luna' },
    ],
  },
  abliteration: {
    id: 'abliteration', name: 'Abliteration',
    models: [{ id: 'abliterated-model-large-v2', name: 'Ablit v2' }],
  },
  cavoti: {
    id: 'cavoti', name: 'Cavoti',
    models: [{ id: 'glm-5.3-flash', name: 'cavoti glm' }],
  },
  someother: {
    id: 'someother', name: 'Other',
    key: 'SECRET-OTHER',
    models: [{ id: 'x', name: 'x' }],
  },
};

test('sanitizeModels strips all secrets', () => {
  const out = sanitizeModels(SAMPLE);
  assert.equal(leaksSecret(out, 'sk-TOP-SECRET'), false);
  assert.equal(leaksSecret(out, 'sk-OPTIONS-KEY'), false);
  assert.equal(leaksSecret(out, 'SECRET-HDR'), false);
  assert.equal(leaksSecret(out, 'or-sk-ROUTER-KEY'), false);
  assert.equal(leaksSecret(out, 'SECRET-OTHER'), false);
});

test('sanitizeModels only includes allowed providers', () => {
  const out = sanitizeModels(SAMPLE);
  const providers = new Set(out.map((m) => m.providerID));
  assert.ok(providers.has('chutes'));
  assert.ok(providers.has('openrouter'));
  assert.ok(providers.has('abliteration'));
  assert.ok(providers.has('cavoti'));
  assert.ok(!providers.has('someother'));
});

test('every sanitized model has exactly the four safe fields', () => {
  const out = sanitizeModels(SAMPLE);
  for (const m of out) {
    const keys = Object.keys(m).sort();
    assert.deepEqual(keys, ['modelID', 'modelName', 'providerID', 'providerName']);
    assert.equal(typeof m.providerID, 'string');
    assert.equal(typeof m.modelID, 'string');
    assert.equal(typeof m.modelName, 'string');
  }
});

test('splitFeatured returns preferred order for present models', () => {
  const out = sanitizeModels(SAMPLE);
  const { featured } = splitFeatured(out);
  const ids = featured.map((m) => m.providerID + '/' + m.modelID);
  assert.deepEqual(ids, [
    'chutes/moonshotai/Kimi-K3-TEE',
    'abliteration/abliterated-model-large-v2',
    'openrouter/nex-agi/nex-n2.5-pro:free',
    'openrouter/z-ai/glm-5.3-flash',
    'cavoti/glm-5.3-flash',
    'openrouter/deepseek/deepseek-v4.1-flash',
    'openrouter/openai/gpt-5.6-luna',
    'chutes/zai-org/GLM-5.2-TEE',
  ]);
});

test('featured only lists models that are actually present', () => {
  const out = sanitizeModels(SAMPLE);
  const { featured } = splitFeatured(out);
  assert.ok(featured.length === 8, 'all 8 preferred models present in sample');
  // drop one model and verify it disappears from featured
  const reduced = sanitizeModels({
    chutes: { id: 'chutes', name: 'Chutes', models: [{ id: 'moonshotai/Kimi-K3-TEE', name: 'x' }] },
  });
  const { featured: f2 } = splitFeatured(reduced);
  assert.equal(f2.length, 1);
});

// Shape actually returned by GET /config/providers on opencode 1.18.18.
const REAL_SHAPE = {
  providers: [
    {
      id: 'chutes', name: 'Chutes AI', source: 'config', env: ['CHUTES_API_KEY'],
      key: 'cpk_REAL-LOOKING-SECRET',
      options: { baseURL: 'https://llm.chutes.ai/v1', apiKey: 'cpk_REAL-LOOKING-SECRET' },
      models: {
        'moonshotai/Kimi-K3-TEE': { id: 'moonshotai/Kimi-K3-TEE', providerID: 'chutes', name: 'Kimi K3 (TEE)', headers: { Authorization: 'Bearer HDR-SECRET' }, options: {} },
      },
    },
    {
      id: 'groq', name: 'Groq', key: 'gsk_SECRET',
      models: { 'llama-3.1-8b-instant': { id: 'llama-3.1-8b-instant', name: 'Llama' } },
    },
  ],
  default: { chutes: 'moonshotai/Kimi-K3-TEE' },
};

test('sanitizeModels handles the real {providers:[{models:{...map}}]} shape', () => {
  const out = sanitizeModels(REAL_SHAPE);
  assert.deepEqual(out, [
    { providerID: 'chutes', providerName: 'Chutes AI', modelID: 'moonshotai/Kimi-K3-TEE', modelName: 'Kimi K3 (TEE)' },
  ]);
  assert.equal(leaksSecret(out, 'cpk_REAL-LOOKING-SECRET'), false);
  assert.equal(leaksSecret(out, 'HDR-SECRET'), false);
  assert.equal(leaksSecret(out, 'gsk_SECRET'), false);
});

test('more is sorted by provider then name and excludes featured', () => {
  const out = sanitizeModels(SAMPLE);
  const { featured, more } = splitFeatured(out);
  const featSet = new Set(featured.map((m) => m.providerID + '/' + m.modelID));
  for (const m of more) {
    assert.ok(!featSet.has(m.providerID + '/' + m.modelID));
  }
  for (let i = 1; i < more.length; i++) {
    const a = more[i - 1], b = more[i];
    const cmp = a.providerID < b.providerID ? -1 : a.providerID > b.providerID ? 1 : a.modelName < b.modelName ? -1 : 1;
    assert.ok(cmp <= 0, 'more must be sorted');
  }
});