import type { Env } from "../../src/types";

export async function resetProductStock(env: Env, productId: string, stock: number = 50) {
  await env.DB.prepare("UPDATE products SET stock = ? WHERE id = ?").bind(stock, productId).run();
}

export async function getProductStock(env: Env, productId: string): Promise<number> {
  const result: any = await env.DB.prepare("SELECT stock FROM products WHERE id = ?").bind(productId).first();
  return (result?.stock as number) ?? 0;
}
