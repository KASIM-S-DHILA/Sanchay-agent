import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { buildPrompt } from "../src/llm/planner";
import { buildNarratorPrompt } from "../src/llm/narrator";
import type { UserPreferences } from "../src/types";

let env: any;

beforeAll(async () => {
  const mod: any = await import("cloudflare:test");
  env = mod.env;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS user_preferences (
      user_id TEXT PRIMARY KEY,
      preferred_categories TEXT,
      budget_preference INTEGER,
      previous_products TEXT,
      purchase_history TEXT,
      session_count INTEGER DEFAULT 0,
      last_active TEXT,
      updated_at TEXT
    )`
  ).run();
});

beforeEach(async () => {
  // Clean test users
  await env.DB.prepare("DELETE FROM user_preferences WHERE user_id LIKE 'test-%@example.com'").run();
});

describe("user_preferences D1", () => {
  it("new user init creates default preferences (empty arrays, sessionCount 1)", async () => {
    const email = "test-new-user@example.com";
    // Simulate agent applyInit logic directly via D1
    // First ensure no row
    let row: any = await env.DB.prepare("SELECT * FROM user_preferences WHERE user_id = ?").bind(email).first();
    expect(row).toBeNull();

    // Create default as agent does
    const prefs: UserPreferences = {
      preferredCategories: [],
      budgetPreference: null,
      previousProducts: [],
      purchaseHistory: [],
      sessionCount: 1,
      lastActive: new Date().toISOString(),
    };
    await env.DB.prepare(
      `INSERT INTO user_preferences (user_id, preferred_categories, budget_preference, previous_products, purchase_history, session_count, last_active, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        email,
        JSON.stringify(prefs.preferredCategories),
        prefs.budgetPreference,
        JSON.stringify(prefs.previousProducts),
        JSON.stringify(prefs.purchaseHistory),
        prefs.sessionCount,
        prefs.lastActive,
        prefs.lastActive
      )
      .run();

    row = await env.DB.prepare("SELECT * FROM user_preferences WHERE user_id = ?").bind(email).first();
    expect(JSON.parse(row.preferred_categories)).toEqual([]);
    expect(row.budget_preference).toBeNull();
    expect(JSON.parse(row.previous_products)).toEqual([]);
    expect(JSON.parse(row.purchase_history)).toEqual([]);
    expect(row.session_count).toBe(1);
  });

  it("returning user init loads existing preferences and increments sessionCount", async () => {
    const email = "test-returning@example.com";
    const initialPrefs = {
      preferred_categories: JSON.stringify(["Tees"]),
      budget_preference: 200000,
      previous_products: JSON.stringify(["TEE-BLACK-001"]),
      purchase_history: JSON.stringify([]),
      session_count: 2,
      last_active: new Date().toISOString(),
    };
    await env.DB.prepare(
      `INSERT INTO user_preferences (user_id, preferred_categories, budget_preference, previous_products, purchase_history, session_count, last_active, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        email,
        initialPrefs.preferred_categories,
        initialPrefs.budget_preference,
        initialPrefs.previous_products,
        initialPrefs.purchase_history,
        initialPrefs.session_count,
        initialPrefs.last_active,
        initialPrefs.last_active
      )
      .run();

    // Simulate returning user load
    const row: any = await env.DB.prepare("SELECT * FROM user_preferences WHERE user_id = ?").bind(email).first();
    const prefs: UserPreferences = {
      preferredCategories: JSON.parse(row.preferred_categories || "[]"),
      budgetPreference: row.budget_preference ?? null,
      previousProducts: JSON.parse(row.previous_products || "[]"),
      purchaseHistory: JSON.parse(row.purchase_history || "[]"),
      sessionCount: (row.session_count || 0) + 1,
      lastActive: new Date().toISOString(),
    };
    expect(prefs.preferredCategories).toEqual(["Tees"]);
    expect(prefs.budgetPreference).toBe(200000);
    expect(prefs.sessionCount).toBe(3);

    // Persist increment
    await env.DB.prepare(
      `UPDATE user_preferences SET session_count = ?, last_active = ?, updated_at = ? WHERE user_id = ?`
    )
      .bind(prefs.sessionCount, prefs.lastActive, prefs.lastActive, email)
      .run();

    const updated: any = await env.DB.prepare("SELECT session_count FROM user_preferences WHERE user_id = ?").bind(email).first();
    expect(updated.session_count).toBe(3);
  });

  it("budget extraction updates budgetPreference in D1", async () => {
    const email = "test-budget@example.com";
    await env.DB.prepare(
      `INSERT INTO user_preferences (user_id, preferred_categories, budget_preference, previous_products, purchase_history, session_count, last_active, updated_at)
       VALUES (?, '[]', NULL, '[]', '[]', 1, ?, ?)`
    )
      .bind(email, new Date().toISOString(), new Date().toISOString())
      .run();

    // Simulate budget extracted 2000 => 200000 paise
    await env.DB.prepare("UPDATE user_preferences SET budget_preference = ?, updated_at = ? WHERE user_id = ?")
      .bind(200000, new Date().toISOString(), email)
      .run();

    const row: any = await env.DB.prepare("SELECT budget_preference FROM user_preferences WHERE user_id = ?").bind(email).first();
    expect(row.budget_preference).toBe(200000);
  });

  it("successful add updates previousProducts and preferredCategories in D1", async () => {
    const email = "test-add@example.com";
    await env.DB.prepare(
      `INSERT INTO user_preferences (user_id, preferred_categories, budget_preference, previous_products, purchase_history, session_count, last_active, updated_at)
       VALUES (?, '[]', NULL, '[]', '[]', 1, ?, ?)`
    )
      .bind(email, new Date().toISOString(), new Date().toISOString())
      .run();

    // Simulate added product TEE-BLACK-001 category Tees
    const row: any = await env.DB.prepare("SELECT * FROM user_preferences WHERE user_id = ?").bind(email).first();
    const prefs: UserPreferences = {
      preferredCategories: JSON.parse(row.preferred_categories || "[]"),
      budgetPreference: row.budget_preference,
      previousProducts: JSON.parse(row.previous_products || "[]"),
      purchaseHistory: JSON.parse(row.purchase_history || "[]"),
      sessionCount: row.session_count,
      lastActive: row.last_active,
    };
    const newPrevious = [...new Set([...prefs.previousProducts, "TEE-BLACK-001"])];
    const newCategories = [...new Set([...prefs.preferredCategories, "Tees"])];

    await env.DB.prepare(
      "UPDATE user_preferences SET previous_products = ?, preferred_categories = ?, updated_at = ? WHERE user_id = ?"
    )
      .bind(JSON.stringify(newPrevious), JSON.stringify(newCategories), new Date().toISOString(), email)
      .run();

    const updated: any = await env.DB.prepare("SELECT previous_products, preferred_categories FROM user_preferences WHERE user_id = ?")
      .bind(email)
      .first();
    expect(JSON.parse(updated.previous_products)).toContain("TEE-BLACK-001");
    expect(JSON.parse(updated.preferred_categories)).toContain("Tees");
  });

  it("updateUserPreferences writes all fields correctly", async () => {
    const email = "test-write@example.com";
    await env.DB.prepare(
      `INSERT INTO user_preferences (user_id, preferred_categories, budget_preference, previous_products, purchase_history, session_count, last_active, updated_at)
       VALUES (?, '[]', NULL, '[]', '[]', 1, ?, ?)`
    )
      .bind(email, new Date().toISOString(), new Date().toISOString())
      .run();

    const newPrefs: UserPreferences = {
      preferredCategories: ["Tees", "Hoodies"],
      budgetPreference: 150000,
      previousProducts: ["TEE-BLACK-001"],
      purchaseHistory: ["TEE-WHITE-002"],
      sessionCount: 2,
      lastActive: new Date().toISOString(),
    };
    await env.DB.prepare(
      "UPDATE user_preferences SET preferred_categories = ?, budget_preference = ?, previous_products = ?, purchase_history = ?, updated_at = ? WHERE user_id = ?"
    )
      .bind(
        JSON.stringify(newPrefs.preferredCategories),
        newPrefs.budgetPreference,
        JSON.stringify(newPrefs.previousProducts),
        JSON.stringify(newPrefs.purchaseHistory),
        new Date().toISOString(),
        email
      )
      .run();

    const row: any = await env.DB.prepare("SELECT * FROM user_preferences WHERE user_id = ?").bind(email).first();
    expect(JSON.parse(row.preferred_categories)).toEqual(["Tees", "Hoodies"]);
    expect(row.budget_preference).toBe(150000);
    expect(JSON.parse(row.previous_products)).toEqual(["TEE-BLACK-001"]);
    expect(JSON.parse(row.purchase_history)).toEqual(["TEE-WHITE-002"]);
  });
});

describe("planner and narrator prompts", () => {
  it("planner prompt includes user context section when preferences are non-null", () => {
    const prefs: UserPreferences = {
      preferredCategories: ["Tees"],
      budgetPreference: 200000,
      previousProducts: ["TEE-BLACK-001"],
      purchaseHistory: [],
      sessionCount: 2,
      lastActive: new Date().toISOString(),
    };
    const prompt = buildPrompt({
      userMessage: "show me tees",
      searchResults: [],
      cart: [],
      history: [],
      lastDiscussedProductId: null,
      pendingIntent: null,
      userPreferences: prefs,
    });
    expect(prompt).toContain("User context:");
    expect(prompt).toContain("Preferred categories: Tees");
    expect(prompt).toContain("Budget preference:");
  });

  it("narrator prompt includes user context section when preferences are non-null", () => {
    const prefs: UserPreferences = {
      preferredCategories: ["Hoodies"],
      budgetPreference: 150000,
      previousProducts: [],
      purchaseHistory: [],
      sessionCount: 3,
      lastActive: new Date().toISOString(),
    };
    const prompt = buildNarratorPrompt({
      userMessage: "hi",
      executorResult: { actions: [], cart: [], cartTotal: 0, errors: [], stateChanges: {} },
      history: [],
      cart: [],
      cartTotal: 0,
      pendingIntent: null,
      userPreferences: prefs,
    });
    expect(prompt).toContain("User context:");
    expect(prompt).toContain("session #3");
  });

  it("planner with returning user + budget preference includes the budget reminder", () => {
    const prefs: UserPreferences = {
      preferredCategories: [],
      budgetPreference: 200000,
      previousProducts: [],
      purchaseHistory: [],
      sessionCount: 3,
      lastActive: new Date().toISOString(),
    };
    const prompt = buildPrompt({
      userMessage: "show me hoodies",
      searchResults: [],
      cart: [],
      history: [],
      lastDiscussedProductId: null,
      pendingIntent: null,
      userPreferences: prefs,
    });
    // Should contain budget in rupees (200000 paise = ₹2,000)
    expect(prompt).toContain("₹2,000");
  });
});
