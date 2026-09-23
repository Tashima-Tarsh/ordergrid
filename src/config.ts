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
  DB_SSL: z.enum(["true","false"]).default("true").transform(v=>v==="true"),
  DB_SSL_REJECT_UNAUTHORIZED: z.enum(["true","false"]).default("true").transform(v=>v==="true"),
  SESSION_SECRET: z.string().min(32),
  OTP_MIN_INTERVAL_MINUTES: z.coerce.number().int().min(1).default(30),
  OTP_RATE_LIMIT_COOLDOWN_HOURS: z.coerce.number().int().min(1).default(6),
  DATA_ENCRYPTION_KEY_BASE64: z.string().min(40),
  BOOTSTRAP_ADMIN_EMAIL: z.string().email(),
  BOOTSTRAP_ADMIN_PASSWORD: z.string().min(14).optional(),
  BOOTSTRAP_ADMIN_SECRET: z.string().min(14).optional(),
  ORDERGRID_SIGNUP_CODE: z.string().min(12).max(512).optional(),
  GOOGLE_CLIENT_ID: z.string().min(20).max(512).optional(),
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
  CARDHOLDER_SPECIAL_DATE: z.string().regex(/^\d{2}-\d{2}-\d{4}$/).optional(),
  CARD_FUNDING_MAX_OVERAGE_PCT: z.coerce.number().int().min(0).max(100).default(10),
  AWS_REGION: z.string().default("ap-southeast-2"),
  BEDROCK_REGION: z.string().default("ap-southeast-2"),
  BEDROCK_MODEL_ID: z.string().default("apac.amazon.nova-lite-v1:0"),
  AWS_BEARER_TOKEN_BEDROCK: z.string().optional()
}).superRefine((value,ctx)=>{
  const knownInsecureSecrets = new Set([
    "ordergrid_session_secret_2026_super_secure_32bytes",
    "ordergrid_worker_token_secure_min_32_chars_2026",
    "YXV0b2dlbmVyYXRlZF8zMmJ5dGVfa2V5X2Zvcg==1234567890abcdef",
    "OrderGrid2026SecurePostgres!",
    "OrderGrid2026SecureAdmin!"
  ]);

  if(!value.DATABASE_URL){
    if(!value.DB_HOST)ctx.addIssue({code:"custom",path:["DB_HOST"],message:"DB_HOST is required when DATABASE_URL is not set"});
    if(!value.DB_USER)ctx.addIssue({code:"custom",path:["DB_USER"],message:"DB_USER is required when DATABASE_URL is not set"});
    if(!value.DB_PASSWORD&&!value.ORDERGRID_DB_TOKEN)ctx.addIssue({code:"custom",path:["ORDERGRID_DB_TOKEN"],message:"A database credential is required when DATABASE_URL is not set"});
  }

  if(value.NODE_ENV==="production"&&!value.WORKER_API_TOKEN)ctx.addIssue({code:"custom",path:["WORKER_API_TOKEN"],message:"WORKER_API_TOKEN is required in production"});
  if(value.NODE_ENV==="production"&&value.WORKER_API_TOKEN&&(value.WORKER_API_TOKEN.length<32||knownInsecureSecrets.has(value.WORKER_API_TOKEN))){
    ctx.addIssue({code:"custom",path:["WORKER_API_TOKEN"],message:"WORKER_API_TOKEN must be a secure random token (min 32 chars) and must not use the repository default"});
  }
  if(value.NODE_ENV==="production"){
    if(value.SESSION_SECRET.length<32||knownInsecureSecrets.has(value.SESSION_SECRET)){
      ctx.addIssue({code:"custom",path:["SESSION_SECRET"],message:"SESSION_SECRET must be a secure random secret (min 32 chars) and must not use the repository default"});
    }
    if(value.DATA_ENCRYPTION_KEY_BASE64.length<40||knownInsecureSecrets.has(value.DATA_ENCRYPTION_KEY_BASE64)){
      ctx.addIssue({code:"custom",path:["DATA_ENCRYPTION_KEY_BASE64"],message:"DATA_ENCRYPTION_KEY_BASE64 must be a secure random base64 key (min 40 chars) and must not use the repository default"});
    }
    if(value.BOOTSTRAP_ADMIN_PASSWORD&&knownInsecureSecrets.has(value.BOOTSTRAP_ADMIN_PASSWORD)){
      ctx.addIssue({code:"custom",path:["BOOTSTRAP_ADMIN_PASSWORD"],message:"BOOTSTRAP_ADMIN_PASSWORD must not use the repository default in production"});
    }
  }
});
export type Config = z.infer<typeof schema>;
export const loadConfig = (): Config => schema.parse(process.env);
