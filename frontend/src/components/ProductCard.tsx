import { useState } from "react";

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

const rupees = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN")}`;

export function ProductCard({
  product,
  onAdd,
  adding,
}: {
  product: CatalogProduct;
  onAdd: (productId: string) => void;
  adding: boolean;
}) {
  const [imgSrc, setImgSrc] = useState(() => safeImageUrl(product.image_url));
  const outOfStock = product.stock <= 0;

  return (
    <li className="product-card">
      <div className="product-image-wrap">
        <img
          src={imgSrc}
          alt={product.name}
          className="product-image"
          loading="lazy"
          onError={() => setImgSrc(PLACEHOLDER_IMAGE)}
        />
        {outOfStock && <span className="product-oos">Out of stock</span>}
      </div>
      <div className="product-info">
        {product.category && <span className="product-category">{product.category}</span>}
        <h3 className="product-name">{product.name}</h3>
        <div className="product-row">
          <span className="product-price">{product.price_display ?? rupees(product.price)}</span>
          <button
            type="button"
            className="product-add-btn"
            onClick={() => onAdd(product.id)}
            disabled={outOfStock || adding}
          >
            {adding ? "Adding…" : outOfStock ? "Sold out" : "Add"}
          </button>
        </div>
      </div>
    </li>
  );
}
