/**
 * Final backstop — guarantees some reply reaches the user even if the
 * narrator, claim-check, and templates all fail.
 */
export function neverSilentGuard(reply: string | null): string {
  if (reply && reply.trim().length > 0) return reply;
  return "Got it! What else can I help with?";
}
