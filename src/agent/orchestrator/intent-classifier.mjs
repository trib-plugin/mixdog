import { embedText } from '../../memory/lib/embedding-provider.mjs';
import { averageVectors, cosineSimilarity } from '../../memory/lib/memory-vector-utils.mjs';

const INTENT_PROTOTYPES = Object.freeze({
  definition_lookup: Object.freeze([
    'Where is `DEFAULT_PRESETS` defined?',
    'Find the definition of `ensureAuth`.',
    '`AuthManager` is defined where?',
    '`FOO_BAR`가 어디에 정의되어 있나요?',
  ]),
  usage_lookup: Object.freeze([
    'Find where `MIXDOG_BRIDGE_TRACE_DISABLE` is used.',
    'Where is `FEATURE_FLAG` used?',
    'Summarize what `FEATURE_FLAG` does.',
    '`FEATURE_FLAG`가 어디에 사용되나요?',
  ]),
  callers: Object.freeze([
    'Who calls `ensureAuth`?',
    'Show callers of `dispatchAiWrapped`.',
    '`ensureAuth`를 누가 호출하나요?',
  ]),
  references: Object.freeze([
    'Where is `ensureAuth` referenced?',
    'Find references of `promptCacheKey`.',
    '`promptCacheKey` 참조 위치를 찾아주세요.',
  ]),
  dependents: Object.freeze([
    'Which files depend on src/agent/orchestrator/providers/openai-oauth.mjs?',
    'What depends on src/foo/bar.mjs?',
    '어떤 파일이 src/foo/bar.mjs에 의존하나요?',
  ]),
  imports: Object.freeze([
    'What does src/agent/orchestrator/providers/openai-oauth.mjs import?',
    'List imports of src/foo/bar.mjs.',
    'src/foo/bar.mjs가 임포트하는 것을 보여주세요.',
  ]),
  compare_known_files: Object.freeze([
    'Compare agents/worker.md and agents/reviewer.md in 3 bullets.',
    'Summarize the differences between file A and file B.',
    '두 파일을 비교해서 요약해 주세요.',
  ]),
});

const CLASSIFIER_CACHE = new Map();
const CLASSIFIER_CACHE_TTL_MS = 10 * 60_000;
let PROTOTYPE_STATE = {
  ready: false,
  promise: null,
  vectors: new Map(),
};

function _candidateKey(candidateLabels) {
  return candidateLabels.slice().sort().join('|');
}

function _cacheGet(prompt, candidateLabels) {
  const key = `${prompt}\n${_candidateKey(candidateLabels)}`;
  const entry = CLASSIFIER_CACHE.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CLASSIFIER_CACHE_TTL_MS) {
    CLASSIFIER_CACHE.delete(key);
    return null;
  }
  return entry.value;
}

function _cacheSet(prompt, candidateLabels, value) {
  const key = `${prompt}\n${_candidateKey(candidateLabels)}`;
  CLASSIFIER_CACHE.set(key, { ts: Date.now(), value });
  if (CLASSIFIER_CACHE.size > 256) {
    const oldest = CLASSIFIER_CACHE.keys().next().value;
    if (oldest) CLASSIFIER_CACHE.delete(oldest);
  }
}

// Per-label in-flight tracking. The previous single-promise design meant
// caller A's promise embedded labels {X,Y}; caller B arriving while that
// promise was in flight saw `PROTOTYPE_STATE.promise` set and awaited it,
// but if B requested labels {Y,Z} the Z embedding was never started and
// `_ensurePrototypeVectors` returned without it. After the await we recheck
// missing labels and kick off a follow-up batch for anything still absent.
const _labelInflight = new Map(); // label -> Promise<void>

function _embedLabel(label) {
  const existing = _labelInflight.get(label);
  if (existing) return existing;
  const p = (async () => {
    const phrases = INTENT_PROTOTYPES[label];
    const vectors = [];
    for (const phrase of phrases) {
      const vector = await embedText(phrase).catch(() => []);
      if (Array.isArray(vector) && vector.length > 0) vectors.push(vector);
    }
    if (vectors.length > 0) {
      PROTOTYPE_STATE.vectors.set(label, averageVectors(vectors));
    }
  })().finally(() => {
    _labelInflight.delete(label);
  });
  _labelInflight.set(label, p);
  return p;
}

async function _ensurePrototypeVectors(candidateLabels) {
  const labels = candidateLabels.filter((label) => Array.isArray(INTENT_PROTOTYPES[label]));
  const missing = labels.filter((label) => !PROTOTYPE_STATE.vectors.has(label));
  if (missing.length === 0) return;
  await Promise.all([...new Set(missing)].map(_embedLabel));
  // Recheck: if any label failed (vector empty / embedText threw), we leave
  // it absent for this call rather than spinning. The next call retries.
  PROTOTYPE_STATE.ready = true;
}

export async function classifyPromptIntent(prompt, candidateLabels = []) {
  const clean = String(prompt || '').trim();
  const labels = candidateLabels.filter((label) => Array.isArray(INTENT_PROTOTYPES[label]));
  if (!clean || labels.length === 0) return null;

  const cached = _cacheGet(clean, labels);
  if (cached !== null) return cached;

  await _ensurePrototypeVectors(labels);
  const queryVec = await embedText(clean).catch(() => []);
  if (!Array.isArray(queryVec) || queryVec.length === 0) {
    _cacheSet(clean, labels, null);
    return null;
  }

  const scored = labels.map((label) => ({
    label,
    score: cosineSimilarity(queryVec, PROTOTYPE_STATE.vectors.get(label) || []),
  })).sort((a, b) => b.score - a.score);

  const best = scored[0];
  const second = scored[1];
  const threshold = 0.42;
  const margin = best?.score >= 0.8 ? 0.015 : 0.03;
  if (!best || best.score < threshold) {
    _cacheSet(clean, labels, null);
    return null;
  }
  if (second && (best.score - second.score) < margin) {
    _cacheSet(clean, labels, null);
    return null;
  }
  _cacheSet(clean, labels, best.label);
  return best.label;
}

export const _internals = {
  INTENT_PROTOTYPES,
};
