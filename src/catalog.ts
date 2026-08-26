export interface CatalogProduct {
  sku: string;
  name: string;
  description: string;
  price: number; // paise — e.g. 79900 = ₹799
  category: string;
  stock: number;
  image_url?: string | null;
}

export const CATALOG: CatalogProduct[] = [
  {
    sku: "TEE-BLACK-001",
    name: "Black Classic Tee",
    description: "Soft cotton black tee perfect for everyday wear. Breathable, relaxed fit.",
    price: 79900,
    category: "Tees",
    stock: 50,
    image_url: "/products/tee-black-001.svg",
  },
  {
    sku: "TEE-WHITE-002",
    name: "White Oversized Tee",
    description: "Premium white oversized tee with dropped shoulders. Minimal streetwear essential.",
    price: 89900,
    category: "Tees",
    stock: 50,
    image_url: "/products/tee-white-002.svg",
  },
  {
    sku: "TEE-BLUE-003",
    name: "Navy Blue Tee",
    description: "Comfortable navy blue tee made from organic cotton. Ideal for layering.",
    price: 84900,
    category: "Tees",
    stock: 50,
    image_url: "/products/tee-blue-003.svg",
  },
  {
    sku: "HOODIE-GRAY-001",
    name: "Gray Pullover Hoodie",
    description: "Cozy gray pullover hoodie with kangaroo pocket. Fleece lined for extra warmth.",
    price: 199900,
    category: "Hoodies",
    stock: 50,
    image_url: "/products/hoodie-gray-001.svg",
  },
  {
    sku: "HOODIE-BLACK-002",
    name: "Black Zip Hoodie",
    description: "Sleek black zip-up hoodie with ribbed cuffs. Versatile for any season.",
    price: 219900,
    category: "Hoodies",
    stock: 50,
    image_url: "/products/hoodie-black-002.svg",
  },
  {
    sku: "JACKET-WARM-001",
    name: "Winter Warm Puffer Jacket",
    description: "Insulated warm puffer jacket for winter. Water-resistant shell, thermal lining for extreme cold.",
    price: 499900,
    category: "Jackets",
    stock: 50,
    image_url: "/products/jacket-warm-001.svg",
  },
  {
    sku: "JACKET-DENIM-001",
    name: "Denim Jacket",
    description: "Classic denim jacket with button front and chest pockets. Timeless casual wear.",
    price: 259900,
    category: "Jackets",
    stock: 50,
    image_url: "/products/jacket-denim-001.svg",
  },
  {
    sku: "SHIRT-WHITE-001",
    name: "Formal White Shirt",
    description: "Crisp formal white shirt with slim fit. Perfect for office and events.",
    price: 149900,
    category: "Shirts",
    stock: 50,
    image_url: "/products/shirt-white-001.svg",
  },
  {
    sku: "SHIRT-FLANNEL-001",
    name: "Checked Flannel Shirt",
    description: "Warm checked flannel shirt with soft brushed interior. Ideal for layering in winter.",
    price: 179900,
    category: "Shirts",
    stock: 50,
    image_url: "/products/shirt-flannel-001.svg",
  },
  {
    sku: "JEANS-SLIM-001",
    name: "Slim Fit Jeans",
    description: "Dark wash slim fit jeans with stretch. Comfortable for all-day wear.",
    price: 229900,
    category: "Pants",
    stock: 50,
    image_url: "/products/jeans-slim-001.svg",
  },
  {
    sku: "PANTS-CARGO-001",
    name: "Cargo Pants",
    description: "Durable cargo pants with multiple pockets. Relaxed fit for outdoor and street style.",
    price: 209900,
    category: "Pants",
    stock: 50,
    image_url: "/products/pants-cargo-001.svg",
  },
  {
    sku: "SNEAKERS-WHITE-001",
    name: "White Sneakers",
    description: "Minimal white sneakers with cushioned sole. Clean look for daily use.",
    price: 299900,
    category: "Shoes",
    stock: 50,
    image_url: "/products/sneakers-white-001.svg",
  },
];
