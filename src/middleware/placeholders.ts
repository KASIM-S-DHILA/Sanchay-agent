/**
 * Detects template placeholders that were never substituted by the caller.
 *
 * Sarvam's tool editor requires agent variables to be inserted as chips (via
 * `@`); text typed as `{{session_id}}` is sent through verbatim. When that
 * happens our endpoints receive the literal string, which is indistinguishable
 * from a genuinely bad value unless we look for it.
 *
 * This mattered because the two failures looked nothing alike. A literal
 * `{{session_id}}` header produced a plain 401 on every cart and checkout
 * call, while a literal `{{query}}` search returned HTTP 200 with whatever the
 * fallback matched — so the agent believed the search had worked and went on to
 * recommend arbitrary products. Silently succeeding with wrong data is the
 * worse of the two, so both are now named explicitly.
 */
export function isUnsubstitutedPlaceholder(value: unknown): boolean {
  return typeof value === "string" && /\{\{.+?\}\}/.test(value.trim());
}

/** Message shown to the agent (and logged) when a placeholder arrives raw. */
export function placeholderError(field: string): string {
  return `The ${field} arrived as an unsubstituted template. In the Sarvam tool editor, insert the variable as a chip with @ instead of typing {{...}} as text.`;
}
