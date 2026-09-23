import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import type { Config } from "./config.js";

export interface BedrockService {
  isAvailable(): Promise<boolean>;
  classifyWorkerFailure(error: string, context?: Record<string, unknown>): Promise<{
    category: string;
    operatorExplanation: string;
    suggestedAction: string;
  }>;
  summarizeBatchFailures(batchId: string, failures: Array<{ orderId?: string; account?: string; error?: string }>): Promise<{
    summary: string;
    actionableItems: string[];
  }>;
  explainAccountStatus(account: { retailer?: string; accountReference?: string; sessionStatus?: string; authStatus?: string; healthScore?: number; cooldownUntil?: string | null }): Promise<string>;
  interpretUnexpectedRetailerMessage(text: string): Promise<{
    intent: string;
    isBlocker: boolean;
    recommendation: string;
  }>;
  generateOperatorRecoverySuggestion(context: Record<string, unknown>): Promise<string>;
}

export class AmazonBedrockService implements BedrockService {
  private client: BedrockRuntimeClient | null = null;
  private modelId: string;
  private region: string;
  private bearerToken: string | null = null;

  constructor(config: Config) {
    this.region = config.BEDROCK_REGION || config.AWS_REGION || "ap-southeast-2";
    this.modelId = config.BEDROCK_MODEL_ID || "apac.amazon.nova-lite-v1:0";
    this.bearerToken = config.AWS_BEARER_TOKEN_BEDROCK || process.env.AWS_BEARER_TOKEN_BEDROCK || null;

    try {
      const clientConfig: any = {
        region: this.region
      };
      if (this.bearerToken) {
        clientConfig.token = { token: this.bearerToken };
      }
      this.client = new BedrockRuntimeClient(clientConfig);
    } catch {
      this.client = null;
    }
  }

  private async converse(prompt: string, systemPrompt?: string): Promise<string | null> {
    if (!this.client) return null;
    try {
      const command = new ConverseCommand({
        modelId: this.modelId,
        system: systemPrompt ? [{ text: systemPrompt }] : [{ text: "You are an operations assistant for OrderGrid bulk procurement platform. Provide precise, actionable analysis. Never invent payment or order status." }],
        messages: [
          {
            role: "user",
            content: [{ text: prompt }]
          }
        ],
        inferenceConfig: {
          maxTokens: 500,
          temperature: 0.1,
          topP: 0.9
        }
      });
      const response = await this.client.send(command);
      const text = response.output?.message?.content?.[0]?.text;
      return text || null;
    } catch (err: any) {
      // If Nova Lite regional model ID fails, try standard amazon.nova-lite-v1:0 or fallback gracefully
      if (this.modelId.includes("apac.") && String(err?.message || "").includes("Unknown")) {
        try {
          const fallbackCommand = new ConverseCommand({
            modelId: "amazon.nova-lite-v1:0",
            system: [{ text: "You are an operations assistant for OrderGrid bulk procurement platform." }],
            messages: [{ role: "user", content: [{ text: prompt }] }],
            inferenceConfig: { maxTokens: 500, temperature: 0.1 }
          });
          const response = await this.client.send(fallbackCommand);
          return response.output?.message?.content?.[0]?.text || null;
        } catch {
          return null;
        }
      }
      return null;
    }
  }

  async isAvailable(): Promise<boolean> {
    if (!this.client) return false;
    try {
      const test = await this.converse("Ping", "Respond with 'pong' only.");
      return Boolean(test);
    } catch {
      return false;
    }
  }

  async classifyWorkerFailure(error: string, context?: Record<string, unknown>): Promise<{
    category: string;
    operatorExplanation: string;
    suggestedAction: string;
  }> {
    const errorLower = error.toLowerCase();
    // Deterministic rule-based classification first
    if (/otp|verification code|one time/i.test(errorLower)) {
      return {
        category: "OTP_REQUIRED",
        operatorExplanation: "Flipkart requires an OTP verification for this account session.",
        suggestedAction: "Enter the OTP in the Action Required inbox."
      };
    }
    if (/captcha|robot/i.test(errorLower)) {
      return {
        category: "CAPTCHA_REQUIRED",
        operatorExplanation: "Flipkart presented a CAPTCHA verification challenge.",
        suggestedAction: "Focus session in Action Required inbox and complete the CAPTCHA."
      };
    }
    if (/price|variance|amount/i.test(errorLower)) {
      return {
        category: "PRICE_VARIANCE",
        operatorExplanation: "Product price changed or exceeded acceptable threshold.",
        suggestedAction: "Review updated pricing before approving checkout continuation."
      };
    }
    if (/out of stock|unavailable|sold out/i.test(errorLower)) {
      return {
        category: "OUT_OF_STOCK",
        operatorExplanation: "The item is currently unavailable from the selected retailer/seller.",
        suggestedAction: "Enable stock watch to auto-resume when replenished or assign an alternate seller."
      };
    }
    if (/login|password|auth/i.test(errorLower)) {
      return {
        category: "LOGIN_REQUIRED",
        operatorExplanation: "Retailer session expired and requires re-authentication.",
        suggestedAction: "Reconnect Flipkart account session with OTP."
      };
    }

    // Call Bedrock for unclassified error analysis
    const bedrockResult = await this.converse(
      `Classify this procurement worker failure and give operator advice:\nError: ${error}\nContext: ${JSON.stringify(context || {})}\n\nRespond in JSON format: {"category":"<CATEGORY>","operatorExplanation":"<EXPLANATION>","suggestedAction":"<ACTION>"}`
    );

    if (bedrockResult) {
      try {
        const parsed = JSON.parse(bedrockResult.match(/\{[\s\S]*\}/)?.[0] || "{}");
        if (parsed.category && parsed.operatorExplanation) {
          return {
            category: parsed.category,
            operatorExplanation: parsed.operatorExplanation,
            suggestedAction: parsed.suggestedAction || "Review the error details in Action Required inbox."
          };
        }
      } catch {}
    }

    return {
      category: "EXECUTION_ERROR",
      operatorExplanation: error.slice(0, 200),
      suggestedAction: "Review order in Action Required inbox."
    };
  }

  async summarizeBatchFailures(batchId: string, failures: Array<{ orderId?: string; account?: string; error?: string }>): Promise<{
    summary: string;
    actionableItems: string[];
  }> {
    if (!failures.length) {
      return {
        summary: "No failures recorded in this batch.",
        actionableItems: []
      };
    }

    const counts = new Map<string, number>();
    for (const f of failures) {
      const msg = f.error || "Unknown error";
      counts.set(msg, (counts.get(msg) || 0) + 1);
    }

    const items = [...counts.entries()].map(([err, count]) => `${count} order(s): ${err}`);

    const bedrockResult = await this.converse(
      `Summarize the following procurement batch failures for an operations dashboard:\nBatch ID: ${batchId}\nFailures: ${JSON.stringify(failures.slice(0, 15))}\n\nProvide a 2-sentence executive summary.`
    );

    return {
      summary: bedrockResult || `${failures.length} order(s) encountered exceptions across ${failures.map(f => f.account).filter(Boolean).length} accounts.`,
      actionableItems: items
    };
  }

  async explainAccountStatus(account: { retailer?: string; accountReference?: string; sessionStatus?: string; authStatus?: string; healthScore?: number; cooldownUntil?: string | null }): Promise<string> {
    if (account.sessionStatus === "READY") {
      return `Account ${account.accountReference} is authenticated and ready for order allocation.`;
    }
    if (account.sessionStatus === "REAUTH_REQUIRED") {
      return `Account ${account.accountReference} requires authentication renewal. Connect via OTP to restore readiness.`;
    }
    if (account.cooldownUntil && new Date(account.cooldownUntil) > new Date()) {
      return `Account ${account.accountReference} is in temporary cooldown until ${new Date(account.cooldownUntil).toLocaleTimeString()} following a previous failure.`;
    }
    return `Account ${account.accountReference} status: ${account.sessionStatus || account.authStatus || "UNKNOWN"}.`;
  }

  async interpretUnexpectedRetailerMessage(text: string): Promise<{
    intent: string;
    isBlocker: boolean;
    recommendation: string;
  }> {
    const bedrockResult = await this.converse(
      `Interpret this unexpected message observed during retailer checkout:\n"${text}"\n\nRespond in JSON: {"intent":"...","isBlocker":true|false,"recommendation":"..."}`
    );

    if (bedrockResult) {
      try {
        const parsed = JSON.parse(bedrockResult.match(/\{[\s\S]*\}/)?.[0] || "{}");
        if (parsed.intent) return parsed;
      } catch {}
    }

    return {
      intent: text.slice(0, 100),
      isBlocker: true,
      recommendation: "Inspect the browser session in Action Required inbox."
    };
  }

  async generateOperatorRecoverySuggestion(context: Record<string, unknown>): Promise<string> {
    const bedrockResult = await this.converse(
      `Suggest the next operator action to recover this stalled procurement order:\nContext: ${JSON.stringify(context)}`
    );

    return bedrockResult || "Review the stalled order in Action Required inbox and choose Retry or Focus Session.";
  }
}

export function createBedrockService(config: Config): BedrockService {
  return new AmazonBedrockService(config);
}
