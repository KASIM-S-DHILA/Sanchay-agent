/**
 * Standalone consent modal for camera/mic access — UI only, no permission
 * requests, no try-on/Decart logic inside. Must be shown (and accepted)
 * BEFORE any camera/mic permission prompt; "Not now" dismisses without
 * triggering anything. Exact approved copy, do not rewrite.
 */
export function TryOnConsentModal({
  onAccept,
  onDecline,
}: {
  onAccept: () => void;
  onDecline: () => void;
}) {
  return (
    <div className="entry-gate" role="dialog" aria-modal="true" aria-label="Camera and microphone consent">
      <div className="entry-gate-card">
        <div className="entry-gate-mark">
          <h1 className="mark-name">Sanchay</h1>
          <span className="mark-role">the counter that listens</span>
        </div>

        <p className="entry-gate-lead">Before we turn on your camera and mic</p>
        <p>
          This is a demo project, not a live store. Here&apos;s what happens if
          you continue:
        </p>
        <ul>
          <li>
            Your camera feed is sent to Decart (virtual try-on rendering) and
            may be shown to Google&apos;s Gemini Live voice agent so it can see
            what you&apos;re trying on and talk you through it.
          </li>
          <li>
            Your voice is sent to Google&apos;s Gemini Live for the voice
            conversation.
          </li>
          <li>
            We keep a screenshot of each look you try on for the rest of your
            session, so you and the agent can refer back to it after the
            camera turns off. It&apos;s deleted the moment you close this tab or
            leave the site — never saved permanently, never seen by anyone else.
          </li>
          <li>
            Payments (if you check out) go through Razorpay in test mode — no
            real charge is made.
          </li>
        </ul>
        <p>You can stop the camera or end the voice session at any time.</p>

        <div className="entry-gate-actions">
          <button type="button" className="btn pay-btn" onClick={onAccept}>
            I understand — Continue
          </button>
          <button type="button" className="auth-gate-cancel" onClick={onDecline}>
            Not now
          </button>
        </div>
      </div>
    </div>
  );
}
