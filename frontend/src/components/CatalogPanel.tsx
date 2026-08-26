import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ProductCard, type CatalogProduct } from "./ProductCard";

export function CatalogPanel({
  onAdd,
  addingId,
}: {
  onAdd: (productId: string) => void;
  addingId: string | null;
}) {
  const [query, setQuery] = useState("");
  const [products, setProducts] = useState<CatalogProduct[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (q: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/catalog?q=${encodeURIComponent(q)}`);
      const data: any = await res.json();
      if (data.success) {
        const items: any[] = data.data?.products ?? [];
        // Backend returns `id` for the no-query listing and `productId` for
        // search results — normalize both to `id` for the card component.
        setProducts(
          items.map((p) => ({
            id: p.id ?? p.productId,
            name: p.name,
            price: p.price,
            price_display: p.price_display,
            category: p.category,
            stock: p.stock,
            image_url: p.image_url ?? null,
            description: p.description,
          })),
        );
      } else {
        setError(data.error ?? "Failed to load catalog");
      }
    } catch {
      setError("Failed to load catalog");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load("");
  }, [load]);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    load(query.trim());
  };

  return (
    <section className="catalog-panel">
      <div className="catalog-head">
        <h2>Shelf</h2>
        <form className="catalog-search" onSubmit={handleSubmit}>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search the shelf — “hoodie”, “jeans”…"
            className="catalog-search-input"
            aria-label="Search catalog"
          />
          <button type="submit" className="catalog-search-btn" disabled={loading}>
            {loading ? "…" : "Search"}
          </button>
        </form>
      </div>

      {error && (
        <p className="catalog-error" role="alert">
          {error}
        </p>
      )}

      {!loading && !error && products.length === 0 ? (
        <p className="catalog-empty">No products found.</p>
      ) : (
        <ul className="product-grid">
          {products.map((p) => (
            <ProductCard key={p.id} product={p} onAdd={onAdd} adding={addingId === p.id} />
          ))}
        </ul>
      )}
    </section>
  );
}
