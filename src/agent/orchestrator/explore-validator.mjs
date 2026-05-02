// explore-agent output validator. Blocks chunk-id hallucinations (#N / `#N`
// / #tag formats) that appear when the explorer role leaks memory-backend ids
// instead of filesystem path:line evidence.
// Body-wide chunk-id patterns. Match anywhere on a line, not just line-start,
// so `from #3937:` mid-sentence and `⟨#46464⟩` angle-bracketed anchors are
// caught alongside line-start `#N` and `` `#N` `` forms.
export const EXPLORE_REJECT_PATTERNS = [
  /(?:^|[\s(\[])#[-\w]+\b/,
  /(?:^|[\s(\[])`#[-\w]+`/,
  /[⟨(\[]#[-\w]+[⟩)\]]/,
]

// Narration / refusal phrases anywhere on the first non-empty line. Word-
// boundary anchored so multi-sentence first lines (e.g. "Found X. Let me Y.")
// still trigger reject. Body-wide scan would over-trigger on legitimate prose
// facts; first-line guard is enough for the common offenders.
export const EXPLORE_FIRST_LINE_NARRATION = [
  /\bLet me \b/i,
  /\bI (?:found|need|see|will|have) \b/i,
  /\bNow I'?ll \b/i,
  /\bLooking at \b/i,
  /\bLet's \b/i,
  /^Perfect[!.]/i,
  /^Found\b/i,
  /^Here(?:'s| are)\b/i,
  /^OK[,.]/i,
  /^Great[!.]/i,
  /^So[,.]/i,
  /^First[,.]/i,
  /정리하겠습니다/,
  /확인하겠습니다/,
  /찾아보겠습니다/,
  /^이 쿼리는 /,
  /^쿼리가 /,
  /^이제 /,
]

export function validateExploreOutput(raw) {
  if (!raw) return true
  const lines = String(raw).split('\n')
  const firstNonEmpty = lines.map(l => l.trim()).find(l => l !== '')
  if (!firstNonEmpty) return true
  if (EXPLORE_FIRST_LINE_NARRATION.some(re => re.test(firstNonEmpty))) return false
  for (const line of lines) {
    if (line.trim() === '') continue
    if (EXPLORE_REJECT_PATTERNS.some(re => re.test(line))) return false
  }
  return true
}

export const EXPLORE_REJECT_FALLBACK =
  '[unverified] explorer output rejected (chunk-id pattern); not found under <root>'

export async function enforceExploreContract(raw, llm, spec, q, resolvedCwd) {
  if (validateExploreOutput(raw)) return raw
  const retryRaw = await llm({
    prompt:
      spec.build(q, resolvedCwd) +
      '\n\nCORRECTION: previous output used memory chunk ids (#N format) which are' +
      ' forbidden — explorer reads filesystem only. Emit ONLY filesystem path:line' +
      ' bullets, or "not found under <root>" plus patterns tried.',
  })
  if (!validateExploreOutput(retryRaw)) return EXPLORE_REJECT_FALLBACK
  return retryRaw
}
