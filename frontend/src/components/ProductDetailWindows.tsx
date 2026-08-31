import { useState } from "react";
import { rupees } from "../config";
import type { ProductWindowData } from "../hooks/useProductWindows";

const PLACEHOLDER_IMAGE = "/products/placeholder.svg";

// Same allowlist ProductCard already applies to image_url — a floating
// window renders an image from the exact same untrusted source (products
// table / agent-resolved id), so it gets the exact same treatment rather
// than a second, possibly-inconsistent sanitizer.
function safeImageUrl(url?: string | null): string {
  if (!url) return PLACEHOLDER_IMAGE;
  if (url.startsWith("/")) return url;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:") parsed.protocol = "https:";
    if (parsed.protocol !== "https:") return PLACEHOLDER_IMAGE;
    return parsed.toString();
  } catch {
    return PLACEHOLDER_IMAGE;
  }
}

/** Side-by-side placement by CURRENT position in the open list (index),
 *  not a persistent, ever-incrementing slot counter. A persistent counter
 *  caused a real bug: with 4 windows open at slots 0-3, closing one and
 *  opening a new one assigned slot 4, which is (4 % 4) = 0 — the exact
 *  same column as the window still sitting at slot 0, so the new window
 *  rendered directly on top of it. Deriving position from the current
 *  array index instead guarantees every currently-open window always
 *  occupies a distinct column, at the minor cost of existing windows
 *  shifting left to fill a gap when one in the middle closes — a shift
 *  that's far less confusing than two windows overlapping. Wraps to a new
 *  row every 4th (matches MAX_OPEN_WINDOWS). */
function cascadeStyle(index: number): React.CSSProperties {
  const i = index % 4;
  return {
    top: "64px",
    left: `${24 + i * 284}px`,
  };
}

function WindowChrome({
  w,
  onClose,
  onAdd,
  adding,
  justAdded,
  onFocus,
  style,
  className,
}: {
  w: ProductWindowData;
  onClose: () => void;
  onAdd: () => void;
  adding: boolean;
  justAdded: boolean;
  onFocus: () => void;
  style?: React.CSSProperties;
  className?: string;
}) {
  const [imgSrc, setImgSrc] = useState(() => safeImageUrl(w.image_url));
  const outOfStock = w.stock <= 0;

  return (
    <div
      className={`product-window ${className ?? ""}`}
      style={style}
      role="dialog"
      aria-label={w.name}
      onMouseDown={onFocus}
    >
      <div className="product-window-head">
        <span className="product-window-cat">{w.category}</span>
        <button type="button" className="product-window-close" onClick={onClose} aria-label={`Close ${w.name}`}>
          ×
        </button>
      </div>
      <div className="product-window-media">
        <img
          src={imgSrc}
          alt={w.name}
          className="product-window-img"
          onError={() => setImgSrc(PLACEHOLDER_IMAGE)}
        />
        {outOfStock && <span className="card-tag">Sold out</span>}
      </div>
      <div className="product-window-body">
        <h3 className="product-window-name">{w.name}</h3>
        <p className="product-window-desc">{w.description}</p>
        {w.visionDescription && (
          <p className="product-window-vision">
            <span className="product-window-vision-label">A closer look</span>
            {w.visionDescription}
          </p>
        )}
        <div className="product-window-foot">
          <span className="product-window-price">{w.price_display ?? rupees(w.price)}</span>
          {justAdded ? (
            <span className="card-added">On the bill</span>
          ) : (
            <button type="button" className="btn btn-sm" onClick={onAdd} disabled={outOfStock || adding}>
              {adding ? "Adding" : outOfStock ? "Sold out" : "Add"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Floating "look closer" windows the agent (or a manual click) opens for
 * specific products — layered on top of the shelf, not replacing it.
 * Desktop: a cascade, each window offset from the last (wrapping every 4th
 * — see cascadeStyle), z-order driven by ProductWindowData.z so clicking
 * one brings it forward. Mobile (see the max-width: 900px rules in
 * styles.css): one card at a time with prev/next arrows over the SAME
 * windows array — no separate mobile data path, just a different
 * presentation of identical state, so voice-driven open/close behaves
 * identically on both.
 */
export function ProductDetailWindows({
  windows,
  onClose,
  onCloseAll,
  onFocus,
  onAdd,
  addingId,
  justAddedId,
  isCallLive,
  isPaused,
  onPause,
  onResume,
}: {
  windows: ProductWindowData[];
  onClose: (productId: string) => void;
  onCloseAll: () => void;
  onFocus: (productId: string) => void;
  onAdd: (productId: string) => void;
  addingId: string | null;
  justAddedId: string | null;
  /** Whether a voice call is currently live — the pause pill only makes
   *  sense to show alongside open windows while there's actually something
   *  to pause; it's not a general-purpose mic control duplicated from
   *  VoiceDock. */
  isCallLive: boolean;
  isPaused: boolean;
  onPause: () => void;
  onResume: () => void;
}) {
  const [mobileIndex, setMobileIndex] = useState(0);

  if (windows.length === 0) return null;

  // Shared between desktop and mobile layouts below — inspecting a window
  // is exactly the moment a shopper most wants to pause without having to
  // scroll back up to the main voice dock, so this rides along with the
  // windows themselves rather than living only in one fixed spot.
  const pausePill = isCallLive && (
    <button
      type="button"
      className={`btn btn-sm product-windows-pause ${isPaused ? "is-paused" : ""}`}
      onClick={isPaused ? onResume : onPause}
    >
      {isPaused ? "Resume Sanchay" : "Pause Sanchay"}
    </button>
  );

  const clampedIndex = Math.min(mobileIndex, windows.length - 1);
  const mobileWindow = windows[clampedIndex];

  return (
    <>
      {/* Desktop cascade — hidden on narrow screens via CSS, not JS, so
          resizing the window doesn't need a re-render to switch modes. */}
      <div className="product-windows-desktop" aria-hidden={false}>
        {windows.map((w, i) => (
          <WindowChrome
            key={w.productId}
            w={w}
            style={{ ...cascadeStyle(i), zIndex: w.z }}
            onClose={() => onClose(w.productId)}
            onAdd={() => onAdd(w.productId)}
            adding={addingId === w.productId}
            justAdded={justAddedId === w.productId}
            onFocus={() => onFocus(w.productId)}
          />
        ))}
        <div className="product-windows-actions" style={{ zIndex: 9999 }}>
          {pausePill}
          {windows.length > 1 && (
            <button type="button" className="btn btn-sm product-windows-close-all" onClick={onCloseAll}>
              Close all ({windows.length})
            </button>
          )}
        </div>
      </div>

      {/* Mobile: one at a time, arrows step through whatever the agent has
          opened. clampedIndex guards against an index that's gone stale
          (e.g. the shopper closed a middle window) pointing past the end. */}
      <div className="product-windows-mobile">
        <WindowChrome
          w={mobileWindow}
          className="is-mobile"
          onClose={() => {
            onClose(mobileWindow.productId);
            setMobileIndex((i) => Math.max(0, i - 1));
          }}
          onAdd={() => onAdd(mobileWindow.productId)}
          adding={addingId === mobileWindow.productId}
          justAdded={justAddedId === mobileWindow.productId}
          onFocus={() => { }}
        />
        {windows.length > 1 && (
          <div className="product-windows-nav">
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setMobileIndex((i) => Math.max(0, i - 1))}
              disabled={clampedIndex === 0}
              aria-label="Previous"
            >
              ‹
            </button>
            <span className="product-windows-nav-count">
              {clampedIndex + 1} / {windows.length}
            </span>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setMobileIndex((i) => Math.min(windows.length - 1, i + 1))}
              disabled={clampedIndex === windows.length - 1}
              aria-label="Next"
            >
              ›
            </button>
          </div>
        )}
        <div className="product-windows-actions">
          {pausePill}
          {windows.length > 1 && (
            <button type="button" className="btn btn-sm product-windows-close-all" onClick={onCloseAll}>
              Close all ({windows.length})
            </button>
          )}
        </div>
      </div>
    </>
  );
}
