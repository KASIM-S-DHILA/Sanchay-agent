import type { AgentState, TurnPlan } from "../types";

export type DecideMode = "confirm" | "cancel" | "actions" | "idle";

const CONFIRM_PHRASES = ["yes", "confirm", "go ahead", "do it", "proceed", "checkout", "buy"] as const;
const CANCEL_PHRASES = ["no", "cancel", "never mind", "forget it", "stop"] as const;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function phraseToRegex(phrase: string): RegExp {
  // Convert phrase to regex with word boundaries and flexible whitespace
  const escaped = escapeRegExp(phrase).replace(/\s+/g, "\\s+");
  return new RegExp(`\\b${escaped}\\b`, "i");
}

export function isConfirmPhrase(text: string): boolean {
  const lower = text.trim().toLowerCase();
  if (!lower) return false;
  for (const phrase of CONFIRM_PHRASES) {
    const regex = phraseToRegex(phrase);
    if (regex.test(lower)) return true;
  }
  return false;
}

export function isCancelPhrase(text: string): boolean {
  const lower = text.trim().toLowerCase();
  if (!lower) return false;
  for (const phrase of CANCEL_PHRASES) {
    const regex = phraseToRegex(phrase);
    if (regex.test(lower)) return true;
  }
  return false;
}

export function decideTurn(
  turnPlan: TurnPlan,
  agentState: AgentState,
  userMessage?: string
): { mode: DecideMode } {
  const hasConfirmPhrase = userMessage ? isConfirmPhrase(userMessage) : false;
  const hasCancelPhrase = userMessage ? isCancelPhrase(userMessage) : false;

  const confirmArmed = agentState.confirmArmed === true;
  const wantsConfirm = turnPlan.requestConfirm === true || hasConfirmPhrase;
  const wantsCancel = turnPlan.requestCancel === true || hasCancelPhrase;

  // Precedence: confirmArmed + confirm phrase wins
  if (confirmArmed && wantsConfirm) {
    return { mode: "confirm" };
  }
  if (confirmArmed && wantsCancel) {
    return { mode: "cancel" };
  }
  // Next: planner explicitly requested confirm/cancel (arming)
  if (turnPlan.requestConfirm === true) {
    return { mode: "confirm" };
  }
  if (turnPlan.requestCancel === true) {
    return { mode: "cancel" };
  }
  // Also check phrase-based confirm/cancel even when not armed? Spec says isConfirmPhrase used by armed-cancel logic,
  // but for decideTurn we should also handle userMessage phrase even if turnPlan didn't set requestConfirm.
  // If userMessage contains confirm/cancel phrase and not armed, we still treat as confirm/cancel if the other conditions didn't hit?
  // The spec's precedence list says:
  // 1. confirmArmed + confirm phrase → confirm
  // 2. confirmArmed + cancel phrase → cancel
  // 3. requestConfirm true → confirm (arm)
  // 4. requestCancel true → cancel
  // 5. actions other than no_action → actions
  // 6. else idle
  // So phrase-only without armed and without requestConfirm should NOT trigger confirm/cancel via decideTurn — itshould be actions/idle.
  // But to make armed-cancel work, we handle phrase check only when armed (above).
  // So no extra handling here.

  // Check for actions
  const hasAction = turnPlan.actions.some((a) => a.type !== "no_action");
  if (hasAction) {
    return { mode: "actions" };
  }

  // RequestConfirm/Cancel both true → confirm wins (already handled above, but explicit)
  if (turnPlan.requestConfirm && turnPlan.requestCancel) {
    return { mode: "confirm" };
  }

  return { mode: "idle" };
}
