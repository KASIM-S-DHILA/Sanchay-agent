/** Static About page — exact approved copy, do not rewrite. */
export function AboutPage({ onBack }: { onBack: () => void }) {
  return (
    <div className="about-page">
      <h2>About Sanchay</h2>
      <p>
        Sanchay is a personal portfolio project built by Kasim to explore
        voice-first shopping experiences — not a real retailer. It exists to
        demonstrate a working system, not to sell clothes.
      </p>

      <h3>What&apos;s real and what isn&apos;t</h3>
      <ul>
        <li>
          The product catalog, voice agent, and try-on rendering are fully
          functional.
        </li>
        <li>
          Checkout uses Razorpay in test mode only. No real payment is ever
          processed, and no order is ever fulfilled or shipped.
        </li>
        <li>
          This site is not a registered business and doesn&apos;t claim to be one.
        </li>
      </ul>

      <h3>Camera and voice data</h3>
      <ul>
        <li>
          Camera frames used for virtual try-on are sent to Decart&apos;s rendering
          API and may be shared with Google&apos;s Gemini Live model so the voice
          agent can see and comment on what you&apos;re trying on.
        </li>
        <li>
          Voice audio is sent to Google&apos;s Gemini Live API for the conversation.
        </li>
        <li>
          A screenshot of each try-on is kept for the rest of your session so
          you and the agent can refer back to it later in the conversation.
          It&apos;s deleted automatically when you close the tab or leave the site —
          we don&apos;t keep it after that, and we don&apos;t use it for anything else.
        </li>
        <li>This feature is intended for users 18 and older.</li>
      </ul>

      <h3>Questions</h3>
      <p>
        This is a solo side project. If something&apos;s broken or you have a
        question about it, reach out at{" "}
        <a href="mailto:kasimdhilawala@gmail.com">kasimdhilawala@gmail.com</a>.
      </p>

      <button type="button" className="btn pay-btn" onClick={onBack}>
        Back to the counter
      </button>
    </div>
  );
}
