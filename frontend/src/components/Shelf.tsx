import { useEffect, useState, type FormEvent } from "react";
import { ProductCard, type CatalogProduct } from "./ProductCard";

/** Who caused the shelf to show what it's showing. Stated on screen, because
 *  a shelf that rearranges itself for no visible reason is unsettling. */
export type ShelfSource = "agent" | "you" | "default";

export function Shelf({
  query,
  source,
  products,
  loading,
  error,
  onSearch,
  onAdd,
  addingId,
  justAddedId,
}: {
  query: string;
  source: ShelfSource;
  products: CatalogProduct[];
  loading: boolean;
  error: string | null;
  onSearch: (query: string) => void;
  onAdd: (productId: string) => void;
  addingId: string | null;
  justAddedId: string | null;
}) {
  const [draft, setDraft] = useState(query);

  // When the agent searches for something, the box catches up so the two
  // never disagree about what's on screen.
  useEffect(() => {
    setDraft(query);
  }, [query]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSearch(draft.trim());
  };

  return (
    <section className="panel" aria-label="Shelf">
      <div className="panel-head shelf-head">
        <h2 className="panel-title">Shelf</h2>
        {query ? (
          <span className={`shelf-why ${source === "agent" ? "is-agent" : ""}`}>
            {source === "agent" ? "Sanchay looked up" : "You searched"} <strong>{query}</strong>
          </span>
        ) : (
          <span className="shelf-why">Everything in stock</span>
        )}
        <form className="shelf-search" onSubmit={submit} role="search">
          <input
            className="input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Search the shelf"
            aria-label="Search the shelf"
          />
          <button type="submit" className="btn btn-sm" disabled={loading}>
            Search
          </button>
        </form>
      </div>

      <div className="shelf-body">
        {error ? (
          <div className="empty">
            <p className="empty-lead">The shelf didn't load</p>
            <p>{error} — try the search again.</p>
          </div>
        ) : loading ? (
          <ul className="shelf-grid" aria-busy="true" aria-label="Loading products">
            {Array.from({ length: 8 }, (_, i) => (
              <li key={i} className="sk-card">
                <div className="sk-media" />
                <div className="sk-lines">
                  <span className="sk-line is-short" />
                  <span className="sk-line" />
                </div>
              </li>
            ))}
          </ul>
        ) : products.length === 0 ? (
          <div className="empty">
            <p className="empty-lead">Nothing matches {query ? `“${query}”` : "that"}</p>
            <p>Try a broader word, or ask Sanchay — he searches by description too.</p>
          </div>
        ) : (
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
        )}
      </div>
    </section>
  );
}
