/**
 * Env-driven config for demo-yopm.
 *
 * IMPORTANT: demo-yopm uses its OWN MongoDB database (`yopm_demo`),
 * separate from YoCore's `yocore` database. The product owns its
 * application data (Projects); YoCore owns identity, billing, workspaces.
 *
 * Set these in `.env` before `pnpm --filter @yocore/demo-yopm dev`:
 *   YOCORE_BASE_URL              http://localhost:3000
 *   YOCORE_PRODUCT_SLUG          yopm-demo
 *   YOCORE_PRODUCT_API_KEY       yc_live_pk_...
 *   YOCORE_PRODUCT_API_SECRET    base64url(32)
 *   YOCORE_WEBHOOK_SECRET        hex(32)            (optional)
 *   YOPM_MONGODB_URI             mongodb://localhost:27017/yopm_demo
 *   DEMO_YOPM_PORT               5175               (optional)
 */
export interface DemoConfig {
  port: number;
  yocoreBaseUrl: string;
  productSlug: string;
  apiKey: string;
  apiSecret: string;
  webhookSecret: string;
  mongoUri: string;
}

export function loadConfig(): DemoConfig {
  return {
    port: Number(process.env['DEMO_YOPM_PORT'] ?? 5175),
    yocoreBaseUrl: process.env['YOCORE_BASE_URL'] ?? 'http://localhost:3000',
    productSlug: process.env['YOCORE_PRODUCT_SLUG'] ?? 'yopm-demo',
    apiKey: process.env['YOCORE_PRODUCT_API_KEY'] ?? 'pk_demo_missing',
    apiSecret: process.env['YOCORE_PRODUCT_API_SECRET'] ?? 'sk_demo_missing',
    webhookSecret: process.env['YOCORE_WEBHOOK_SECRET'] ?? 'whsec_demo_missing',
    mongoUri: process.env['YOPM_MONGODB_URI'] ?? 'mongodb://localhost:27017/yopm_demo',
  };
}
