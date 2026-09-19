import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  APP_ORIGIN: z.string().url(),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  SESSION_SECRET: z.string().min(32),
  DATA_ENCRYPTION_KEY_BASE64: z.string().min(40),
  BOOTSTRAP_ADMIN_EMAIL: z.string().email(),
  BOOTSTRAP_ADMIN_PASSWORD: z.string().min(14),
  SHOPIFY_STOREFRONT_TOKEN: z.string().optional(),
  CARD_PROVIDER: z.enum(["disabled", "m2p", "enkash", "custom"]).default("disabled"),
  CARD_PROVIDER_API_KEY: z.string().optional(),
  CARD_PROVIDER_WEBHOOK_SECRET: z.string().optional()
});
export type Config = z.infer<typeof schema>;
export const loadConfig = (): Config => schema.parse(process.env);
