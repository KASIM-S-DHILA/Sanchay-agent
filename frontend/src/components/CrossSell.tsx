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
 * in src/api/logic.ts). Reuses ProductCard so image-safety/fallback handling
 * stays in one place. Renders nothing when there are no suggestions — no
 * placeholder, since an empty array is a normal outcome (no real cross-sell
 * signal yet), not something to draw attention to.
 */
export function CrossSell({
  suggestions,
  onAdd,
  addingId,
  justAddedId,
}: {
  suggestions: CrossSellSuggestion[];
  onAdd: (productId: string) => void;
  addingId: string | null;
  justAddedId: string | null;
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
    <section className="panel" aria-label="Goes with your bill">
      <div className="panel-head">
        <h2 className="panel-title">Goes with your bill</h2>
        <span className="panel-note">based on what you've added</span>
      </div>
      <div className="shelf-body">
        <ul className="shelf-grid">
          {products.map((p) => (
            <ProductCard
              key={p.id}
              product={p}
              onAdd={onAdd}
              adding={addingId === p.id}
              justAdded={justAddedId === p.id}
            />
          ))}
        </ul>
      </div>
    </section>
  );
}
