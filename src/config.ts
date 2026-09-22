import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  APP_ORIGIN: z.string().url(),
  DATABASE_URL: z.string().min(1).optional(),
  DB_HOST: z.string().min(1).optional(),
  DB_PORT: z.coerce.number().int().positive().default(5432),
  DB_POOL_MAX: z.coerce.number().int().min(2).max(10).default(5),
  DB_NAME: z.string().min(1).default("postgres"),
  DB_USER: z.string().min(1).optional(),
  DB_PASSWORD: z.string().min(1).optional(),
  ORDERGRID_DB_TOKEN: z.string().min(1).optional(),
  REDIS_URL: z.string().min(1).optional(),
  WORKER_API_TOKEN: z.string().min(32).optional(),
  DB_SSL_REJECT_UNAUTHORIZED: z.enum(["true","false"]).default("true").transform(v=>v==="true"),
  SESSION_SECRET: z.string().min(32),
  DATA_ENCRYPTION_KEY_BASE64: z.string().min(40),
  BOOTSTRAP_ADMIN_EMAIL: z.string().email(),
  BOOTSTRAP_ADMIN_PASSWORD: z.string().min(14).optional(),
  BOOTSTRAP_ADMIN_SECRET: z.string().min(14).optional(),
  ORDERGRID_SIGNUP_CODE: z.string().min(12).max(512).optional(),
  SHOPIFY_STOREFRONT_TOKEN: z.string().optional(),
  CARD_PROVIDER: z.enum(["disabled", "m2p", "enkash", "custom"]).default("disabled"),
  CARD_PROVIDER_API_KEY: z.string().optional(),
  CARD_PROVIDER_WEBHOOK_SECRET: z.string().optional(),
  ENKASH_BASE_URL: z.string().url().optional(),
  ENKASH_TOKEN_URL: z.string().url().optional(),
  ENKASH_PARTNER_ID: z.string().optional(),
  ENKASH_BASIC_AUTH: z.string().optional(),
  ENKASH_USERNAME: z.string().optional(),
  ENKASH_PASSWORD: z.string().optional(),
  ENKASH_CLIENT_ID: z.string().optional(),
  ENKASH_COMPANY_ID: z.string().optional(),
  ENKASH_CARD_ACCOUNT_ID: z.string().optional(),
  CARDHOLDER_EMAIL: z.string().email().optional(),
  CARDHOLDER_MOBILE: z.string().regex(/^\d{10,15}$/).optional(),
  CARDHOLDER_FIRST_NAME: z.string().min(1).max(60).optional(),
  CARDHOLDER_LAST_NAME: z.string().min(1).max(60).optional(),
  CARDHOLDER_GENDER: z.enum(["M","F","O"]).optional(),
  CARDHOLDER_PAN: z.string().regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/).optional(),
  CARDHOLDER_SPECIAL_DATE: z.string().regex(/^\d{2}-\d{2}-\d{4}$/).optional()
}).superRefine((value,ctx)=>{
  if(value.DATABASE_URL)return;
  if(!value.DB_HOST)ctx.addIssue({code:"custom",path:["DB_HOST"],message:"DB_HOST is required when DATABASE_URL is not set"});
  if(!value.DB_USER)ctx.addIssue({code:"custom",path:["DB_USER"],message:"DB_USER is required when DATABASE_URL is not set"});
  if(!value.DB_PASSWORD&&!value.ORDERGRID_DB_TOKEN)ctx.addIssue({code:"custom",path:["ORDERGRID_DB_TOKEN"],message:"A database credential is required when DATABASE_URL is not set"});
  if(!value.BOOTSTRAP_ADMIN_PASSWORD&&!value.BOOTSTRAP_ADMIN_SECRET)ctx.addIssue({code:"custom",path:["BOOTSTRAP_ADMIN_SECRET"],message:"A bootstrap administrator secret is required"});
  if(value.NODE_ENV==="production"&&!value.WORKER_API_TOKEN)ctx.addIssue({code:"custom",path:["WORKER_API_TOKEN"],message:"WORKER_API_TOKEN is required in production"});
});
export type Config = z.infer<typeof schema>;
export const loadConfig = (): Config => schema.parse(process.env);
