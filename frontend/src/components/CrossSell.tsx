import { ProductCard, type CatalogProduct } from "./ProductCard";

export interface CrossSellSuggestion {
  productId: string;
  name: string;
  price: number;
  price_display: string;
  category: string;
  image_url: string | null;
}

/**
 * Renders the backend's youMightAlsoLike suggestions (see getCart/addToCart
 * in src/api/logic.ts) as a small horizontal strip beneath the bill. Reuses
 * ProductCard so image-safety/fallback handling stays in one place. Renders
 * nothing when there are no suggestions — no placeholder/empty state, since
 * an empty array here is a normal outcome (no real cross-sell signal yet),
 * not something to draw attention to.
 */
export function CrossSell({
  suggestions,
  onAdd,
  addingId,
}: {
  suggestions: CrossSellSuggestion[];
  onAdd: (productId: string) => void;
  addingId: string | null;
}) {
  if (!suggestions || suggestions.length === 0) return null;

  const products: CatalogProduct[] = suggestions.map((s) => ({
    id: s.productId,
    name: s.name,
    price: s.price,
    price_display: s.price_display,
    category: s.category,
    stock: 1, // suggestions are already filtered to in-stock products server-side
    image_url: s.image_url,
  }));

  return (
    <div className="cross-sell">
      <span className="cross-sell-label">You might also like</span>
      <ul className="cross-sell-list">
        {products.map((p) => (
          <ProductCard key={p.id} product={p} onAdd={onAdd} adding={addingId === p.id} />
        ))}
      </ul>
    </div>
  );
}
