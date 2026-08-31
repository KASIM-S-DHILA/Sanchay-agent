import { useEffect, useRef } from "react";
import type { Transcript as TranscriptEntry } from "../hooks/useGeminiLive";

type CallState = "idle" | "connecting" | "listening" | "speaking";

/** Things worth saying first. Clicking one runs the same catalog search the
 *  agent's own tool runs, so the shelf visibly answers — which teaches the
 *  mapping between what you say and what moves on screen. */
const OPENERS = ["hoodies", "jeans", "something under 1500"];

function Meter({ level, tone }: { level: number; tone: "mic" | "agent" }) {
  return (
    <div
      className={`meter ${level > 0.02 ? (tone === "agent" ? "is-agent" : "is-active") : ""}`}
      style={{ ["--level" as string]: level.toFixed(3) }}
      aria-hidden
    >
      {Array.from({ length: 7 }, (_, i) => (
        <span key={i} className="meter-bar" />
      ))}
    </div>
  );
}

export function VoiceDock({
  callState,
  transcripts,
  error,
  micLevel,
  agentLevel,
  isPaused,
  onStart,
  onStop,
  onPause,
  onResume,
  onDismissError,
  onTry,
}: {
  callState: CallState;
  transcripts: TranscriptEntry[];
  error: string | null;
  micLevel: number;
  agentLevel: number;
  isPaused: boolean;
  onStart: () => void;
  onStop: () => void;
  onPause: () => void;
  onResume: () => void;
  onDismissError: () => void;
  onTry: (query: string) => void;
}) {
  const tapeRef = useRef<HTMLDivElement | null>(null);

  // Keep the newest turn in view without yanking the page around it.
  useEffect(() => {
    const el = tapeRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [transcripts.length]);

  const live = callState === "listening" || callState === "speaking";
  const speaking = callState === "speaking";

  return (
    <section className="panel dock" aria-label="Voice">
      <div className="dock-main">
        {live ? (
          <>
            <button
              type="button"
              className={`talk-btn is-live ${isPaused ? "is-paused" : ""}`}
              onClick={isPaused ? onResume : onStop}
            >
              <span className="talk-dot" aria-hidden />
              {isPaused ? "Paused — tap to resume" : speaking ? "Sanchay is talking" : "Listening"}
            </button>
            <Meter level={isPaused ? 0 : speaking ? agentLevel : micLevel} tone={speaking ? "agent" : "mic"} />
            <div className="dock-state">
              <span className="dock-state-label is-live">
                {isPaused ? "Mic is off — nothing is being heard" : speaking ? "Hold on — hear him out" : "Go ahead, speak"}
              </span>
              <span className="dock-hint">
                {isPaused
                  ? "Resume when you're ready to keep talking."
                  : speaking
                    ? "Cut in any time; he'll stop."
                    : "Ask for something, or say “checkout” when the bill looks right."}
              </span>
            </div>
            <div className="dock-actions">
              {/* Pausing only stops the mic — the call stays open, so
                  resuming picks the SAME conversation back up (cart, name,
                  everything already said) rather than starting over. */}
              <button
                type="button"
                className="btn btn-sm"
                onClick={isPaused ? onResume : onPause}
              >
                {isPaused ? "Resume" : "Pause"}
              </button>
              <button type="button" className="btn btn-sm dock-end" onClick={onStop}>
                End call
              </button>
            </div>
          </>
        ) : callState === "connecting" ? (
          <>
            <button type="button" className="talk-btn is-connecting" disabled>
              <span className="talk-dot" aria-hidden />
              Opening the counter
            </button>
            <div className="dock-state">
              <span className="dock-state-label">Connecting</span>
              <span className="dock-hint">Allow the microphone when your browser asks.</span>
            </div>
          </>
        ) : (
          <>
            <button type="button" className="talk-btn" onClick={onStart}>
              <span className="talk-dot" aria-hidden />
              Talk to Sanchay
            </button>
            <div className="dock-state">
              <span className="dock-state-label">Ready when you are</span>
              <span className="dock-hint">He searches the shelf, fills the bill and takes payment.</span>
            </div>
          </>
        )}
      </div>

      {/* Announce state changes for screen readers without duplicating them
          visually — the button label above already carries it. */}
      <span className="sr-only" role="status" aria-live="polite">
        {live
          ? isPaused
            ? "Paused"
            : speaking
              ? "Sanchay is speaking"
              : "Listening"
          : callState === "connecting"
            ? "Connecting"
            : "Call ended"}
      </span>

      {error && (
        <p className="dock-error" role="alert">
          <span style={{ flex: 1 }}>{error}</span>
          <button type="button" className="btn btn-sm" onClick={onDismissError}>
            Dismiss
          </button>
        </p>
      )}

      {transcripts.length > 0 ? (
        <div className="tape" ref={tapeRef} aria-label="What was said" tabIndex={0}>
          {transcripts.map((t, i) => (
            <div key={i} className={`tape-turn is-${t.role}`}>
              <span className="tape-who">{t.role === "agent" ? "Sanchay" : "You"}</span>
              <span className="tape-text">{t.text}</span>
            </div>
          ))}
        </div>
      ) : (
        callState === "idle" && (
          <div className="dock-open">
            <span className="dock-open-label">Try asking for</span>
            <div className="tries">
              {OPENERS.map((q) => (
                <button key={q} type="button" className="try" onClick={() => onTry(q)}>
                  <span className="try-quote">“</span>
                  {q}
                  <span className="try-quote">”</span>
                </button>
              ))}
            </div>
          </div>
        )
      )}
    </section>
  );
}
