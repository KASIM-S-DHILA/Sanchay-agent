import { useState } from "react";
import { rupees } from "../config";

export interface CatalogProduct {
  id: string;
  name: string;
  price: number; // paise
  price_display?: string;
  category?: string;
  stock: number;
  image_url?: string | null;
  description?: string;
}

const PLACEHOLDER_IMAGE = "/products/placeholder.svg";

// Untrusted product data (future Flipkart import, agent-supplied URLs) may
// contain http://, javascript:, data:, or malformed URLs. Only local assets
// and https URLs are allowed through; everything else falls back to the
// placeholder so a bad image_url can never break layout or execute script.
function safeImageUrl(url?: string | null): string {
  if (!url) return PLACEHOLDER_IMAGE;
  if (url.startsWith("/")) return url; // local asset, always safe
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:") parsed.protocol = "https:"; // avoid mixed-content blocks
    if (parsed.protocol !== "https:") return PLACEHOLDER_IMAGE;
    return parsed.toString();
  } catch {
    return PLACEHOLDER_IMAGE;
  }
}

export function ProductCard({
  product,
  onAdd,
  adding,
  justAdded,
}: {
  product: CatalogProduct;
  onAdd: (productId: string) => void;
  adding: boolean;
  justAdded?: boolean;
}) {
  const [imgSrc, setImgSrc] = useState(() => safeImageUrl(product.image_url));
  const outOfStock = product.stock <= 0;

  return (
    <li className={`card ${outOfStock ? "is-out" : ""}`}>
      <div className="card-media">
        <img
          src={imgSrc}
          alt={product.name}
          className="card-img"
          loading="lazy"
          onError={() => setImgSrc(PLACEHOLDER_IMAGE)}
        />
        {outOfStock && <span className="card-tag">Sold out</span>}
      </div>
      <div className="card-body">
        {product.category && <span className="card-cat">{product.category}</span>}
        <h3 className="card-name">{product.name}</h3>
        <div className="card-foot">
          <span className="card-price">{product.price_display ?? rupees(product.price)}</span>
          {justAdded ? (
            <span className="card-added">On the bill</span>
          ) : (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => onAdd(product.id)}
              disabled={outOfStock || adding}
            >
              {adding ? "Adding" : outOfStock ? "Sold out" : "Add"}
            </button>
          )}
        </div>
      </div>
    </li>
  );
}
