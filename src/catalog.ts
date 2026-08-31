export interface CatalogProduct {
  sku: string;
  name: string;
  description: string;
  price: number; // paise — e.g. 79900 = ₹799
  category: string;
  stock: number;
  image_url?: string | null;
}

// Curated from apparel.csv (a Shopify partner demo dataset — burst.shopifycdn.com
// images are Shopify Burst stock photos, free to hotlink). Every product below
// has a real image; the CSV's own placeholder-priced rows (₹50-80 flat, clearly
// demo filler) were repriced to something realistic for the described garment
// rather than imported as-is. The one multi-variant row in the source
// (Classic Varsity Top: Small/Medium/Large) is collapsed into a single product —
// Sanchay's cart has no size dimension. Every row here maps 1:1 to a CSV
// "Handle" that shipped with an Image Src.
export const CATALOG: CatalogProduct[] = [
  {
    sku: "ocean-blue-shirt",
    name: "Ocean Blue Shirt",
    description: "Ocean blue cotton shirt with a narrow collar, buttons down the front, and long sleeves. Comfortable fit with a subtle kaleidoscope pattern.",
    price: 129900,
    category: "Shirts",
    stock: 30,
    image_url: "https://burst.shopifycdn.com/photos/young-man-in-bright-fashion_925x.jpg",
  },
  {
    sku: "classic-varsity-top",
    name: "Classic Varsity Top",
    description: "Women's casual varsity top. This grey and black buttoned top is a sport-inspired piece complete with an embroidered letter.",
    price: 149900,
    category: "Tops",
    stock: 30,
    image_url: "https://burst.shopifycdn.com/photos/casual-fashion-woman_925x.jpg",
  },
  {
    sku: "yellow-wool-jumper",
    name: "Yellow Wool Jumper",
    description: "Knitted jumper in a soft wool blend with dropped shoulders, wide sleeves, and thick cuffs. Perfect for keeping warm during fall.",
    price: 199900,
    category: "Sweaters",
    stock: 25,
    image_url: "https://burst.shopifycdn.com/photos/autumn-photographer-taking-picture_925x.jpg",
  },
  {
    sku: "floral-white-top",
    name: "Floral White Top",
    description: "Stylish sleeveless white top with a floral pattern.",
    price: 99900,
    category: "Tops",
    stock: 30,
    image_url: "https://burst.shopifycdn.com/photos/city-woman-fashion_925x@2x.jpg",
  },
  {
    sku: "striped-silk-blouse",
    name: "Striped Silk Blouse",
    description: "Ultra-stylish black and red striped silk blouse with a buckle collar, matched with buttoned pants.",
    price: 179900,
    category: "Tops",
    stock: 20,
    image_url: "https://burst.shopifycdn.com/photos/striped-blouse-fashion_925x.jpg",
  },
  {
    sku: "classic-leather-jacket",
    name: "Classic Leather Jacket",
    description: "Women's zipped leather jacket with an adjustable belt for a comfortable fit, shoulder pads, and a front zip pocket.",
    price: 449900,
    category: "Jackets",
    stock: 15,
    image_url: "https://burst.shopifycdn.com/photos/leather-jacket-and-tea_925x.jpg",
  },
  {
    sku: "dark-denim-top",
    name: "Dark Denim Top",
    description: "Classic dark denim top with chest pockets, long sleeves with buttoned cuffs, and a ripped hem effect.",
    price: 159900,
    category: "Tops",
    stock: 30,
    image_url: "https://burst.shopifycdn.com/photos/young-female-models-denim_925x.jpg",
  },
  {
    sku: "navy-sport-jacket",
    name: "Navy Sports Jacket",
    description: "Long-sleeved navy waterproof jacket in thin polyester fabric with a soft mesh inside. The durable water-repellent finish keeps you comfortable and protected in all weather.",
    price: 249900,
    category: "Jackets",
    stock: 25,
    image_url: "https://burst.shopifycdn.com/photos/mens-fall-fashion-jacket_925x.jpg",
  },
  {
    sku: "dark-winter-jacket",
    name: "Soft Winter Jacket",
    description: "Thick black winter jacket with soft fleece lining. Perfect for those cold weather days.",
    price: 399900,
    category: "Jackets",
    stock: 20,
    image_url: "https://burst.shopifycdn.com/photos/smiling-woman-on-snowy-afternoon_925x.jpg",
  },
  {
    sku: "black-leather-bag",
    name: "Black Leather Bag",
    description: "Women's black leather bag with ample space. Can be worn over the shoulder, or the straps removed to carry by hand.",
    price: 229900,
    category: "Bags",
    stock: 20,
    image_url: "https://burst.shopifycdn.com/photos/black-bag-over-the-shoulder_925x.jpg",
  },
  {
    sku: "zipped-jacket",
    name: "Zipped Jacket",
    description: "Dark navy and light blue men's zipped waterproof jacket with an outer zipped chest pocket for easy storage.",
    price: 219900,
    category: "Jackets",
    stock: 25,
    image_url: "https://burst.shopifycdn.com/photos/menswear-blue-zip-up-jacket_925x.jpg",
  },
  {
    sku: "silk-summer-top",
    name: "Silk Summer Top",
    description: "Silk women's top with short sleeves and a number pattern.",
    price: 169900,
    category: "Tops",
    stock: 25,
    image_url: "https://burst.shopifycdn.com/photos/young-hip-woman-at-carnival_925x.jpg",
  },
  {
    sku: "longsleeve-cotton-top",
    name: "Long Sleeve Cotton Top",
    description: "Black cotton women's top with long sleeves, no collar, and a thick hem.",
    price: 119900,
    category: "Tops",
    stock: 30,
    image_url: "https://burst.shopifycdn.com/photos/woman-outside-brownstone_925x.jpg",
  },
  {
    sku: "chequered-red-shirt",
    name: "Chequered Red Shirt",
    description: "Classic men's plaid flannel shirt with long sleeves, in a chequered style, with two chest pockets.",
    price: 139900,
    category: "Shirts",
    stock: 30,
    image_url: "https://burst.shopifycdn.com/photos/red-plaid-shirt_925x.jpg",
  },
  {
    sku: "white-cotton-shirt",
    name: "White Cotton Shirt",
    description: "Plain white cotton long-sleeved shirt with a loose collar, small buttons, and a front pocket.",
    price: 109900,
    category: "Shirts",
    stock: 30,
    image_url: "https://burst.shopifycdn.com/photos/smiling-woman-poses_925x.jpg",
  },
  {
    sku: "olive-green-jacket",
    name: "Olive Green Jacket",
    description: "Loose-fitting olive green jacket with buttons and large pockets. Multicoloured pattern across the front of the shoulders.",
    price: 269900,
    category: "Jackets",
    stock: 20,
    image_url: "https://burst.shopifycdn.com/photos/urban-fashion_925x.jpg",
  },
  {
    sku: "blue-silk-tuxedo",
    name: "Blue Silk Tuxedo",
    description: "Blue silk tuxedo with a marbled aquatic pattern and dark lining. Sleeves finished with a rounded hem and black buttons.",
    price: 549900,
    category: "Formalwear",
    stock: 10,
    image_url: "https://burst.shopifycdn.com/photos/man-adjusts-blue-tuxedo-bowtie_925x.jpg",
  },
  {
    sku: "red-sports-tee",
    name: "Red Sports Tee",
    description: "Women's red sporty t-shirt with colorful details on the sleeves and a small white pocket.",
    price: 79900,
    category: "Tees",
    stock: 35,
    image_url: "https://burst.shopifycdn.com/photos/womens-red-t-shirt_925x.jpg",
  },
  {
    sku: "striped-skirt-and-top",
    name: "Striped Skirt and Top",
    description: "Black cotton top with a matching striped skirt.",
    price: 189900,
    category: "Tops",
    stock: 20,
    image_url: "https://burst.shopifycdn.com/photos/woman-in-the-city_925x.jpg",
  },
  {
    sku: "led-high-tops",
    name: "LED High Tops",
    description: "Black high-top shoes with green LED lights in the sole, tied up with laces and a buckle.",
    price: 299900,
    category: "Shoes",
    stock: 20,
    image_url: "https://burst.shopifycdn.com/photos/putting-on-your-shoes_925x.jpg",
  },
];
