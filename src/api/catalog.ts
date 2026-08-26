import type { Env, ProductSearchResult } from "../types";
import { searchProducts } from "../catalog/search";
import { json, withApiLogging } from "../middleware/audit";
import { validateSession } from "../middleware/session";

export async function handleCatalogSearch(request: Request, env: Env, url: URL): Promise<Response> {
  const session = await validateSession(env, request);
  const q = url.searchParams.get("q")?.trim() || null;
  const limit = Math.min(Number(url.searchParams.get("limit")) || 5, 20);

  return withApiLogging(
    env,
    { sessionId: session?.id ?? null, endpoint: "/api/catalog", method: "GET", params: { q, limit } },
    async () => {
      if (q) {
        const results = await searchProducts(env, q, limit);
        return json({
          success: true as const,
          data: { products: results.map(toCatalogProduct) },
        });
      }

      const result = await env.DB.prepare(
        "SELECT id, name, price, stock, category FROM products",
      ).all<any>();
      const products = (result.results ?? []).map((p) => ({
        id: p.id as string,
        name: p.name as string,
        price: p.price as number, // paise
        stock: p.stock as number,
        category: p.category as string,
      }));
      return json({ success: true as const, data: { products } });
    },
  );
}

function toCatalogProduct(p: ProductSearchResult) {
  return {
    id: p.productId,
    name: p.name,
    price: p.price, // paise
    price_display: `₹${(p.price / 100).toLocaleString("en-IN")}`,
    stock: p.stock,
    category: p.category,
  };
}

