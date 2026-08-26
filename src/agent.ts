import { Agent, callable } from "agents";
import { buildFacts } from "./claim-check/facts";
import { claimsConsistent } from "./claim-check/index";
import { neverSilentGuard } from "./claim-check/never-silent";
import { renderFallback } from "./claim-check/templates";
import { embedProducts } from "./catalog/embed";
import { searchProducts } from "./catalog/search";
import { seedCatalog } from "./catalog/seed";
import { decideTurn, isCancelPhrase, isConfirmPhrase } from "./executor/decide-turn";
import { executeTurn } from "./executor/index";
import { callNarrator } from "./llm/narrator";
import { callPlanner } from "./llm/planner";
import { createChatProvider } from "./llm/provider-factory";
import { extractBudgetIntent } from "./mandates";
import { issueIntentMandate } from "./mandates/jwt";
import { checkProbeGate, getProbeRefusal } from "./safety/probe-gate";
import type { AgentState, Env, TurnPlan, TurnRecord, UserPreferences } from "./types";

export class SanchayAgent extends Agent<Env, AgentState> {
  // ---- lifecycle ---------------------------------------------------------

  async onStart() {
    // Ensure audit table exists
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        action TEXT NOT NULL,
        actor TEXT NOT NULL,
        sku TEXT,
        order_id TEXT,
        payment_id TEXT,
        amount_paise INTEGER,
        bound_paise INTEGER,
        status TEXT NOT NULL,
        reason TEXT NOT NULL,
        detail TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_events(ts DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_session ON audit_events(session_id);
    `);

    // Seed catalog and embeddings (idempotent)
    try {
      await seedCatalog(this.env);
    } catch (e) {
      console.error("seedCatalog failed:", e);
    }
    // Fire-and-forget embeddings — don't block onStart (WebSocket would timeout)
    embedProducts(this.env).catch((e) => console.error("embedProducts failed:", e));
  }

  initialState: AgentState = {
    cart: [],
    history: [],
    lastDiscussedProductId: null,
    pendingIntent: null,
    confirmArmed: false,
    sessionMeta: null,
    userPreferences: null,
  };

  // ---- cross-session user preferences ------------------------------------

  private static PREFERENCES_DDL = `
    CREATE TABLE IF NOT EXISTS user_preferences (
      user_id TEXT PRIMARY KEY,
      preferred_categories TEXT,
      budget_preference INTEGER,
      previous_products TEXT,
      purchase_history TEXT,
      session_count INTEGER DEFAULT 0,
      last_active TEXT,
      updated_at TEXT
    );
  `;

  /** Init handshake — load-or-create prefs, bump sessionCount, persist. */
  async applyInit(email: string): Promise<UserPreferences> {
    this.commitState({
      sessionMeta: { userId: email, expiresAt: new Date(Date.now() + 3_600_000).toISOString() },
    });

    await this.env.DB.prepare(SanchayAgent.PREFERENCES_DDL).run();
    const row: any = await this.env.DB.prepare("SELECT * FROM user_preferences WHERE user_id = ?")
      .bind(email)
      .first();

    let prefs: UserPreferences;
    if (row) {
      prefs = {
        preferredCategories: JSON.parse(row.preferred_categories || "[]"),
        budgetPreference: row.budget_preference ?? null,
        previousProducts: JSON.parse(row.previous_products || "[]"),
        purchaseHistory: JSON.parse(row.purchase_history || "[]"),
        sessionCount: (row.session_count || 0) + 1,
        lastActive: new Date().toISOString(),
      };
    } else {
      prefs = {
        preferredCategories: [],
        budgetPreference: null,
        previousProducts: [],
        purchaseHistory: [],
        sessionCount: 1,
        lastActive: new Date().toISOString(),
      };
    }
    this.commitState({ userPreferences: prefs });

    await this.env.DB.prepare(
      `INSERT INTO user_preferences
         (user_id, preferred_categories, budget_preference, previous_products, purchase_history, session_count, last_active, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         session_count = excluded.session_count, last_active = excluded.last_active, updated_at = excluded.updated_at`,
    )
      .bind(
        email,
        JSON.stringify(prefs.preferredCategories),
        prefs.budgetPreference,
        JSON.stringify(prefs.previousProducts),
        JSON.stringify(prefs.purchaseHistory),
        prefs.sessionCount,
        prefs.lastActive,
        prefs.lastActive,
      )
      .run();

    return prefs;
  }

  /** Stage 2 hook — remember the latest budget mandate. */
  async recordBudget(budgetPaise: number): Promise<void> {
    if (!this.state.userPreferences) return;
    const next = { ...this.state.userPreferences, budgetPreference: budgetPaise };
    this.commitState({ userPreferences: next });
    await this.updateUserPreferences();
  }

  /** Post-executor hook — merge added product ids + their categories. */
  async recordAddedProducts(productIds: string[]): Promise<void> {
    if (!this.state.userPreferences || productIds.length === 0) return;
    const categories = await this.fetchProductCategories(productIds);
    const next: UserPreferences = {
      ...this.state.userPreferences,
      previousProducts: [...new Set([...this.state.userPreferences.previousProducts, ...productIds])],
      preferredCategories: [...new Set([...this.state.userPreferences.preferredCategories, ...categories])],
    };
    this.commitState({ userPreferences: next });
    await this.updateUserPreferences();
  }

  private async fetchProductCategories(productIds: string[]): Promise<string[]> {
    if (productIds.length === 0) return [];
    const placeholders = productIds.map(() => "?").join(", ");
    const result = await this.env.DB.prepare(
      `SELECT DISTINCT category FROM products WHERE id IN (${placeholders})`,
    )
      .bind(...productIds)
      .all<{ category: string }>();
    return (result.results ?? []).map((r) => r.category).filter(Boolean);
  }

  private async updateUserPreferences(): Promise<void> {
    if (!this.state.userPreferences || !this.state.sessionMeta) return;
    const prefs = this.state.userPreferences;
    const userId = this.state.sessionMeta.userId;
    await this.env.DB.prepare(
      "UPDATE user_preferences SET preferred_categories = ?, budget_preference = ?, previous_products = ?, purchase_history = ?, updated_at = ? WHERE user_id = ?",
    )
      .bind(
        JSON.stringify(prefs.preferredCategories),
        prefs.budgetPreference,
        JSON.stringify(prefs.previousProducts),
        JSON.stringify(prefs.purchaseHistory),
        new Date().toISOString(),
        userId,
      )
      .run();
  }

  /** Webhook support — resolve the buyer email for an order's session. */
  async getUserEmail(): Promise<string | null> {
    return this.state.sessionMeta?.userId ?? null;
  }

  async onConnect() {
    // Welcome is deferred until the init handshake delivers the buyer email
  }

  /**
   * Per-session audit trail read over same-runtime DO RPC.
   * Used by the /audit endpoint in src/index.ts — @callable is only
   * required for cross-runtime (browser) callers.
   */
  async getAuditEvents(): Promise<{ events: Record<string, unknown>[] }> {
    // Self-heal — direct RPC can race onStart on a cold DO instance
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        action TEXT NOT NULL,
        actor TEXT NOT NULL,
        sku TEXT,
        order_id TEXT,
        payment_id TEXT,
        amount_paise INTEGER,
        bound_paise INTEGER,
        status TEXT NOT NULL,
        reason TEXT NOT NULL,
        detail TEXT
      );
    `);
    const results = this.ctx.storage.sql
      .exec("SELECT * FROM audit_events WHERE session_id = ? ORDER BY ts ASC", this.name)
      .toArray();
    return { events: results as unknown as Record<string, unknown>[] };
  }

  async onMessage(connection: WebSocket, message: string | ArrayBuffer) {
    // Parse the incoming message
    let parsed: { type: string; content?: string; email?: string };
    try {
      parsed = JSON.parse(
        typeof message === "string" ? message : new TextDecoder().decode(message),
      );
    } catch {
      connection.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
      return;
    }

    if (parsed.type !== "chat" || !parsed.content) {
      // init handshake — capture buyer email, load cross-session preferences
      if (parsed.type === "init" && parsed.email) {
        const prefs = await this.applyInit(parsed.email);
        this.audit({
          action: "session.init",
          actor: "user",
          status: "ok",
          reason: prefs.sessionCount > 1 ? `returning user, session ${prefs.sessionCount}` : "new user",
          detail: parsed.email,
        });
        connection.send(
          JSON.stringify({
            type: "connected",
            sessionId: this.name,
            cart: this.state.cart,
          }),
        );
        return;
      }
      connection.send(
        JSON.stringify({
          type: "error",
          message: "Expected { type: 'chat', content: '...' }",
        }),
      );
      return;
    }

    const userMessage = parsed.content.trim();

    // STAGE 1: Probe gate — early return, no LLM
    const probeResult = checkProbeGate(userMessage);
    if (probeResult.blocked) {
      const reply = getProbeRefusal(probeResult.reason!);
      this.audit({
        action: "probe_gate.blocked",
        actor: "system",
        status: "blocked",
        reason: probeResult.reason ?? "unknown",
      });
      this.commitState({
        history: [...this.state.history, { role: "assistant", content: reply, timestamp: new Date().toISOString() }],
      });
      connection.send(JSON.stringify({ type: "chat", content: reply, cart: this.state.cart }));
      return;
    }

    // STAGE 2: Budget extractor — mandate side-effect
    const budget = extractBudgetIntent(userMessage);
    if (budget.detected) {
      const jwt = await issueIntentMandate(this.env, this.name, budget.value!, budget.span!);
      this.audit({
        action: "budget.extracted",
        actor: "system",
        status: "ok",
        reason: `budget ${budget.value} paise`,
        detail: budget.span,
      });
      this.commitState({ pendingIntent: { type: "confirm", budgetValue: budget.value, span: budget.span } });
      await this.recordBudget(budget.value!);
    }

    // STAGE 3: Semantic search — narrow catalog for the planner
    const searchResults = await searchProducts(this.env, userMessage, 5);
    this.audit({
      action: "search.executed",
      actor: "system",
      status: "ok",
      reason: `query="${userMessage.slice(0, 50)}" results=${searchResults.length}`,
      detail: searchResults.map((r) => r.productId).join(","),
    });

    // STAGE 3.5: Pre-LLM short-circuit — user confirming or cancelling
    if (this.state.confirmArmed) {
      const isConfirm = isConfirmPhrase(userMessage);
      const isCancel = isCancelPhrase(userMessage);

      if (isConfirm) {
        // Execute checkout immediately — no LLM needed for the decision
        const executorResult = await executeTurn({
          env: this.env,
          turnPlan: { actions: [], requestConfirm: true, requestCancel: false, reasoning: "User confirmed checkout", reply: "" },
          agentState: this.state,
          searchResults,
          userMessage,
          sessionId: this.name,
        });

        if (executorResult.stateChanges && Object.keys(executorResult.stateChanges).length > 0) {
          this.commitState(executorResult.stateChanges);
        }
        this.audit({
          action: "checkout.executed",
          actor: "user",
          status: executorResult.actions[0].success ? "ok" : "failed",
          reason: `order=${executorResult.actions[0].orderId ?? "none"}`,
          detail: executorResult.actions[0].error ?? executorResult.actions[0].paymentUrl,
        });

        // Narrator describes the checkout outcome
        let narratorReply: string;
        try {
          narratorReply = await callNarrator(createChatProvider(this.env), {
            userMessage,
            executorResult,
            history: this.state.history,
            cart: this.state.cart,
            cartTotal: executorResult.cartTotal,
            pendingIntent: this.state.pendingIntent,
        userPreferences: this.state.userPreferences,
          });
        } catch {
          narratorReply = renderFallback(buildFacts(executorResult));
        }

        // Claim-check narrator against facts (checkout_initiated → confirm_executed)
        const facts = buildFacts(executorResult);
        const check = claimsConsistent(narratorReply, facts);
        const finalReply = neverSilentGuard(check.consistent ? narratorReply : renderFallback(facts));

        // Persist and respond with payment link
        const turnRecord: TurnRecord = {
          role: "user",
          content: userMessage,
          timestamp: new Date().toISOString(),
        };
        this.commitState({ history: [...this.state.history.slice(-7), turnRecord] });
        const assistantRecord: TurnRecord = {
          role: "assistant",
          content: finalReply,
          timestamp: new Date().toISOString(),
          actions: ["checkout"],
        };
        this.commitState({ history: [...this.state.history, assistantRecord] });
        connection.send(
          JSON.stringify({
            type: "chat",
            content: finalReply,
            cart: this.state.cart,
            paymentUrl: executorResult.actions.find((a) => a.type === "checkout_initiated" && a.success)?.paymentUrl,
            executor: executorResult, // debug
          }),
        );
        return;
      }

      if (isCancel) {
        // Disarm confirm — no LLM needed
        this.commitState({ confirmArmed: false });
        this.audit({ action: "confirm.disarmed", actor: "user", status: "ok", reason: "User cancelled checkout" });
        const cancelReply = "No problem! Your cart is saved. What would you like to do next?";
        const turnRecord: TurnRecord = {
          role: "user",
          content: userMessage,
          timestamp: new Date().toISOString(),
        };
        this.commitState({ history: [...this.state.history.slice(-7), turnRecord] });
        const assistantRecord: TurnRecord = {
          role: "assistant",
          content: cancelReply,
          timestamp: new Date().toISOString(),
          actions: ["cancel"],
        };
        this.commitState({ history: [...this.state.history, assistantRecord] });
        connection.send(JSON.stringify({ type: "chat", content: cancelReply, cart: this.state.cart }));
        return;
      }
      // If armed but neither, fall through to planner (user may be modifying cart)
    }

    // STAGE 4: Planner LLM call
    let turnPlan: TurnPlan;
    try {
      turnPlan = await callPlanner(this.env, {
        userMessage,
        searchResults,
        cart: this.state.cart,
        history: this.state.history,
        lastDiscussedProductId: this.state.lastDiscussedProductId,
        pendingIntent: this.state.pendingIntent,
        userPreferences: this.state.userPreferences,
      });
    } catch (e) {
      turnPlan = {
        actions: [{ type: "no_action" }],
        requestConfirm: false,
        requestCancel: false,
        reasoning: `Planner error: ${e}`,
        reply: "Sorry, I encountered an error processing your request.",
      };
    }

    this.audit({
      action: "planner.executed",
      actor: "system",
      status: turnPlan.actions.length > 0 && turnPlan.actions[0].type !== "no_action" ? "ok" : "empty",
      reason: `actions=${turnPlan.actions.map((a) => a.type).join(",")} confirm=${turnPlan.requestConfirm} cancel=${turnPlan.requestCancel}`,
      detail: turnPlan.reasoning,
    });

    // STAGE 5: Executor — validate and execute the plan
    const mode = decideTurn(turnPlan, this.state, userMessage);
    const executorResult = await executeTurn({
      env: this.env,
      turnPlan,
      agentState: this.state,
      searchResults,
      userMessage,
      sessionId: this.name,
    });

    if (executorResult.stateChanges && Object.keys(executorResult.stateChanges).length > 0) {
      this.commitState(executorResult.stateChanges);
    }

    this.audit({
      action: "executor.executed",
      actor: "system",
      status: executorResult.errors.length > 0 ? "partial" : "ok",
      reason: `mode=${mode.mode} actions=${executorResult.actions.map((a) => `${a.type}:${a.success}`).join(",")}`,
      detail: executorResult.errors.join("; ") || undefined,
    });

    // Audit each successful cart mutation (money-relevant)
    for (const a of executorResult.actions) {
      if ((a.type === "add" || a.type === "remove") && a.success) {
        this.audit({
          action: "cart.mutated",
          actor: "agent",
          sku: a.productId,
          amount_paise: a.price,
          bound_paise: this.state.pendingIntent?.budgetValue,
          status: "ok",
          reason: `${a.type} ${a.productName ?? a.productId}${a.quantity ? ` x${a.quantity}` : ""}`,
        });
      } else if (a.type === "cart_cleared" && a.success) {
        this.audit({
          action: "cart.mutated",
          actor: "agent",
          status: "ok",
          reason: "cart cleared",
        });
      } else if (a.type === "confirm_armed") {
        this.audit({
          action: "confirm.armed",
          actor: "system",
          status: "ok",
          reason: "checkout confirmation required",
        });
      }
    }

    // Cross-session memory — remember successful adds
    const addedProductIds = executorResult.actions
      .filter((a) => a.type === "add" && a.success)
      .map((a) => a.productId!)
      .filter(Boolean);
    if (addedProductIds.length > 0) {
      await this.recordAddedProducts(addedProductIds);
    }

    // STAGE 6: Narrator — generate natural reply from executor results
    let narratorReply: string;
    try {
      narratorReply = await callNarrator(createChatProvider(this.env), {
        userMessage,
        executorResult,
        history: this.state.history,
        cart: this.state.cart,
        cartTotal: executorResult.cartTotal,
        pendingIntent: this.state.pendingIntent,
        userPreferences: this.state.userPreferences,
        searchResults,
      });
    } catch (e) {
      narratorReply = "Got it! Your cart has been updated. What else can I help with?";
    }

    // STAGE 7: Claim-check — validate narrator output against facts
    const facts = buildFacts(executorResult, searchResults);
    const knownProductNames = [
      ...new Set([...searchResults.map((r) => r.name), ...this.state.cart.map((c) => c.name)]),
    ];
    const check = claimsConsistent(narratorReply, facts, { knownProductNames });

    let finalReply: string;
    if (check.consistent) {
      finalReply = narratorReply;
      this.audit({
        action: "claim_check.passed",
        actor: "system",
        status: "ok",
        reason: "narrator output consistent with facts",
      });
    } else {
      console.warn(`Claim-check violations: ${check.violations.join("; ")}`);
      finalReply = renderFallback(facts);
      this.audit({
        action: "claim_check.failed",
        actor: "system",
        status: "blocked",
        reason: `narrator output discarded: ${check.violations.join("; ")}`,
        detail: `Original: ${narratorReply.slice(0, 200)}`,
      });
    }

    // STAGE 8: Never-silent guard
    finalReply = neverSilentGuard(finalReply);

    // STAGE 9: Persist and respond
    const turnRecord: TurnRecord = {
      role: "user",
      content: userMessage,
      timestamp: new Date().toISOString(),
    };
    this.commitState({ history: [...this.state.history.slice(-7), turnRecord] });

    const assistantRecord: TurnRecord = {
      role: "assistant",
      content: finalReply,
      timestamp: new Date().toISOString(),
      actions: executorResult.actions.map((a) => a.type),
    };
    this.commitState({ history: [...this.state.history, assistantRecord] });

    connection.send(
      JSON.stringify({
        type: "chat",
        content: finalReply,
        cart: this.state.cart,
        plan: turnPlan, // debug
        executor: executorResult, // debug
      }),
    );
  }

  async onClose(connection: WebSocket) {
    console.log(`Session ${this.name} disconnected`);
  }

  // ---- state helpers -----------------------------------------------------

  private commitState(partial: Partial<AgentState>) {
    this.setState({ ...this.state, ...partial });
  }

  // ---- callable methods for frontend RPC ---------------------------------

  // ponytail: callable() is typed for TC39 decorators but esbuild only
  // transforms legacy ones (tsconfig: experimentalDecorators) — runtime
  // behavior is identical (it just tags the method), so suppress the
  // signature mismatch here.
  // @ts-expect-error legacy decorator signature vs SDK typing
  @callable()
  getCart() {
    return this.state.cart;
  }

  // @ts-expect-error legacy decorator signature vs SDK typing
  @callable()
  getSessionState() {
    return this.state;
  }

  // ---- audit helper ------------------------------------------------------

  private audit(event: {
    action: string;
    actor: string;
    sku?: string;
    order_id?: string;
    payment_id?: string;
    amount_paise?: number;
    bound_paise?: number;
    status: string;
    reason: string;
    detail?: string;
  }) {
    this.ctx.storage.sql.exec(
      `INSERT INTO audit_events (ts, session_id, action, actor, sku, order_id, payment_id, amount_paise, bound_paise, status, reason, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      Date.now(),
      this.name,
      event.action,
      event.actor,
      event.sku ?? null,
      event.order_id ?? null,
      event.payment_id ?? null,
      event.amount_paise ?? null,
      event.bound_paise ?? null,
      event.status,
      event.reason,
      event.detail ?? null,
    );
  }
}


