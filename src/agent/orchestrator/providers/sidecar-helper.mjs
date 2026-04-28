// Cache-safe warn-sidecar emission helper for string-content providers.
//
// loop.mjs attaches `warnSidecar` to a tool message as an out-of-band
// advisory string. The naive emission — `${m.content}\n\n${sidecar}` —
// MUTATES the content chunk that providers without explicit cache
// breakpoints (OpenAI Responses, OpenAI Chat, Gemini) hash for prefix
// caching, dropping cache hits from that message onward.
//
// This helper detaches the sidecar so the caller can re-emit it as a
// SEPARATE follow-on item in the provider's native shape. Original
// tool_result content stays byte-identical, so the cache prefix keeps
// matching across iterations.
//
// Anthropic providers handle the sidecar differently (a second
// multi-content text block AFTER the BP1 cache_control marker) and
// do not need this helper — that path is more efficient because the
// sidecar block sits past the cached prefix without inflating the
// message count.
export function splitWithSidecars(messages) {
    if (!Array.isArray(messages)) return [];
    const out = [];
    for (const m of messages) {
        if (!m || !m.warnSidecar) {
            out.push({ message: m, sidecar: null });
            continue;
        }
        const { warnSidecar, ...clean } = m;
        out.push({ message: clean, sidecar: warnSidecar });
    }
    return out;
}
