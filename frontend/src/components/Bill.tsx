import { useState, type FormEvent } from "react";
import { rupees } from "../config";

export interface BillItem {
  productId: string;
  name: string;
  price: number;
  quantity: number;
}

export interface PaymentState {
  orderId: string;
  amount: number;
  /** pending: Razorpay is open or yet to open. dismissed: the shopper closed
   *  the window without finishing. paid: the Worker confirmed it. */
  stage: "pending" | "dismissed" | "paid";
}

/**
 * The bill. This is the one warm, physical object in the app, and the only
 * place the monospace face and paper palette are allowed.
 *
 * It shows three things a shopper has to be able to trust without reading
 * documentation: what's on it, what it's capped at, and what will happen if
 * they pay. Nothing here is decorative — the leader dots tie a name to a
 * number, and the stamp appears only once money has actually moved.
 */
export function Bill({
  sessionId,
  items,
  total,
  count,
  budgetRemaining,
  payment,
  busy,
  email,
  onEmailChange,
  onSetBudget,
  onPay,
  onResumePayment,
}: {
  sessionId: string | null;
  items: BillItem[];
  total: number;
  count: number;
  budgetRemaining: number | null;
  payment: PaymentState | null;
  busy: boolean;
  email: string;
  onEmailChange: (value: string) => void;
  onSetBudget: (rupeeValue: number) => Promise<boolean>;
  onPay: () => void;
  onResumePayment: () => void;
}) {
  const [capInput, setCapInput] = useState("");
  const [savingCap, setSavingCap] = useState(false);

  // getCart reports what's left, not the cap itself — the cap is the two
  // added back together.
  const cap = budgetRemaining === null ? null : total + budgetRemaining;
  const spentRatio = cap && cap > 0 ? Math.min(1, total / cap) : 0;
  const tight = cap !== null && budgetRemaining !== null && budgetRemaining <= cap * 0.15;

  const paid = payment?.stage === "paid";
  const awaiting = payment && payment.stage !== "paid";

  const submitCap = async (e: FormEvent) => {
    e.preventDefault();
    const value = Number(capInput);
    if (!Number.isFinite(value) || value <= 0) return;
    setSavingCap(true);
    const ok = await onSetBudget(value);
    setSavingCap(false);
    if (ok) setCapInput("");
  };

  return (
    <section className="bill" aria-label="Your bill">
      <div className="bill-head">
        <h2 className="bill-mark">Bill</h2>
        <span className="bill-no">
          {sessionId ? `no. ${sessionId.slice(0, 6).toUpperCase()}` : "no counter open"}
        </span>
      </div>

      {items.length === 0 ? (
        <p className="bill-empty">
          Nothing on the bill yet.
          <br />
          Say <strong>“add the grey hoodie”</strong> and it lands here, priced.
        </p>
      ) : (
        <>
          <ul className="bill-lines">
            {items.map((item) => (
              <li key={item.productId} className="bill-line">
                <span className="bill-qty">{item.quantity}×</span>
                <span className="bill-item">{item.name}</span>
                <span className="bill-leader" aria-hidden />
                <span className="bill-amt">{rupees(item.price * item.quantity)}</span>
              </li>
            ))}
          </ul>
          <hr className="bill-drop" />
          <div className="bill-sum">
            <div className="bill-sum-row">
              <span>{count} {count === 1 ? "piece" : "pieces"}</span>
              <span>{items.length} {items.length === 1 ? "line" : "lines"}</span>
            </div>
            <div className="bill-total">
              <span className="bill-total-label">Total</span>
              <span className="bill-total-amt">{rupees(total)}</span>
            </div>
          </div>
        </>
      )}

      {/* — Spending cap. Visible whether or not one is set, because the
            absence of a cap is itself something worth knowing. — */}
      {sessionId && !paid && (
        <div className="cap">
          <div className="cap-head">
            <span>Spending cap</span>
            {cap !== null && <span className="cap-left">{rupees(budgetRemaining ?? 0)} left of {rupees(cap)}</span>}
          </div>
          {cap !== null ? (
            <>
              <div
                className="cap-track"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={cap}
                aria-valuenow={total}
                aria-label="Spent against your cap"
              >
                <div
                  className={`cap-fill ${tight ? "is-tight" : ""}`}
                  style={{ width: `${Math.max(2, spentRatio * 100)}%` }}
                />
              </div>
              <p className="cap-note">
                Sanchay refuses anything that would push the bill past this. Say “make my budget
                three thousand” to change it.
              </p>
            </>
          ) : (
            <>
              <form className="cap-form" onSubmit={submitCap}>
                <input
                  className="input"
                  inputMode="numeric"
                  value={capInput}
                  onChange={(e) => setCapInput(e.target.value)}
                  placeholder="e.g. 3000"
                  aria-label="Spending cap in rupees"
                />
                <button type="submit" className="btn btn-sm" disabled={savingCap || !capInput.trim()}>
                  {savingCap ? "Setting" : "Set cap"}
                </button>
              </form>
              <p className="cap-note">No cap set. Set one and every add is checked against it.</p>
            </>
          )}
        </div>
      )}

      {/* — Payment. The gate is spelled out before the money moves. — */}
      {paid ? (
        <div className="bill-paid">
          <span className="stamp">Paid</span>
          <span className="paid-detail">
            <span className="paid-label">{rupees(payment!.amount)} settled</span>
            <span className="paid-order">{payment!.orderId}</span>
          </span>
        </div>
      ) : awaiting ? (
        <div className="pay">
          <div className="pay-pending">
            <span className="pay-pending-text">
              {payment!.stage === "dismissed" ? (
                <>
                  You closed the payment window before it finished. Nothing was charged and the bill
                  is untouched — <strong>{rupees(payment!.amount)}</strong> is still due.
                </>
              ) : (
                <>
                  Waiting for payment of <strong>{rupees(payment!.amount)}</strong>. The bill stays
                  locked until it clears.
                </>
              )}
            </span>
            <button type="button" className="btn btn-sm" onClick={onResumePayment}>
              {payment!.stage === "dismissed" ? "Resume payment" : "Reopen payment window"}
            </button>
          </div>
        </div>
      ) : (
        items.length > 0 && (
          <div className="pay">
            <ul className="pay-checks">
              <li className="pay-check">
                {rupees(total)} across {count} {count === 1 ? "piece" : "pieces"}
              </li>
              {cap !== null && (
                <li className="pay-check">Inside your {rupees(cap)} cap</li>
              )}
              <li className="pay-check">Stock and the merchant's order limit are re-checked now</li>
            </ul>
            <button
              type="button"
              className="btn pay-btn"
              onClick={onPay}
              disabled={busy}
            >
              {busy ? "Opening payment" : `Pay ${rupees(total)}`}
            </button>
          </div>
        )
      )}

      {/* Email is only wired into session start, so it's offered before the
          counter opens and reported as a fact afterwards. Never a field that
          silently does nothing. */}
      {!sessionId ? (
        <details className="bill-email">
          <summary>Keep a copy of this bill</summary>
          <div className="bill-email-body">
            <input
              className="input"
              type="email"
              value={email}
              onChange={(e) => onEmailChange(e.target.value)}
              placeholder="you@example.com"
              aria-label="Email for order history"
            />
            <span className="bill-email-note">
              Optional. Used to recognise you next visit and keep your past bills together.
            </span>
          </div>
        </details>
      ) : (
        email && (
          <div className="bill-email">
            <span className="bill-email-note">Filed under {email}</span>
          </div>
        )
      )}
    </section>
  );
}
