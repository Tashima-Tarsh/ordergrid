import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EnKashVirtualCardIssuer, type VirtualCardIssuer } from "../src/card-issuer.js";
import { GenericBankVirtualCardIssuer } from "../src/bank-card-issuer.js";
import { DirectCardVirtualCardIssuer } from "../src/issuer-connections.js";
import type { Config } from "../src/config.js";
import type { Db } from "../src/db.js";
import {
  ensureBasketVirtualCard,
  cleanupBasketVirtualCard,
  applyBasketCardProvisioning
} from "../src/card-provisioning.js";
import { encryptJson } from "../src/security.js";

const TEST_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

function createTestConfig(overrides: Partial<Config> = {}): Config {
  return {
    PORT: 3000,
    NODE_ENV: "test",
    APP_ORIGIN: "http://localhost:3000",
    SESSION_SECRET: "test-secret-32-bytes-minimum-length-key!",
    DATA_ENCRYPTION_KEY_BASE64: TEST_KEY,
    REDIS_URL: "redis://localhost:6379",
    DB_HOST: "localhost",
    DB_PORT: 5432,
    DB_NAME: "ordergrid_test",
    DB_USER: "postgres",
    DB_PASSWORD: "password",
    DB_POOL_MAX: 10,
    DB_SSL: false,
    DB_SSL_REJECT_UNAUTHORIZED: true,
    CARD_PROVIDER: "direct_card",
    CARD_FUNDING_MAX_OVERAGE_PCT: 10,
    CARDHOLDER_EMAIL: "holder@example.com",
    CARDHOLDER_MOBILE: "9876543210",
    CARDHOLDER_FIRST_NAME: "John",
    CARDHOLDER_LAST_NAME: "Doe",
    CARDHOLDER_GENDER: "M",
    CARDHOLDER_PAN: "ABCDE1234F",
    CARDHOLDER_SPECIAL_DATE: "01-01-1990",
    ...overrides
  } as Config;
}

interface MockStore {
  baskets: Map<string, any>;
  batches: Map<string, any>;
  purchase_orders: Map<string, any>;
  virtual_cards: Map<string, any>;
  issuer_connections: Map<string, any>;
  audit_logs: any[];
}

function createMockDbStore(initialData?: Partial<MockStore>) {
  const store: MockStore = {
    baskets: new Map(),
    batches: new Map(),
    purchase_orders: new Map(),
    virtual_cards: new Map(),
    issuer_connections: new Map(),
    audit_logs: [],
    ...initialData
  };

  let cardIdCounter = 100;

  const executeQuery = async (sql: string, params: any[] = []): Promise<{ rows: any[]; rowCount: number }> => {
    const normalized = sql.replace(/\s+/g, " ").trim();

    if (/^begin/i.test(normalized) || /^commit/i.test(normalized) || /^rollback/i.test(normalized)) {
      return { rows: [], rowCount: 0 };
    }

    // Basket join query in ensureBasketVirtualCard
    if (normalized.includes("from checkout_baskets cb") && normalized.includes("join order_batches b")) {
      const basketId = params[0];
      const tenantId = params[1];
      const basket = store.baskets.get(basketId);
      if (!basket || basket.tenant_id !== tenantId) {
        return { rows: [], rowCount: 0 };
      }
      const batch = store.batches.get(basket.batch_id) || { payment_route: "Corporate virtual card" };
      let sumAmount = 0;
      for (const po of store.purchase_orders.values()) {
        if (po.checkout_basket_id === basketId) {
          sumAmount += Number(po.amount_minor || 0);
        }
      }
      if (sumAmount === 0 && basket.amount_minor) {
        sumAmount = Number(basket.amount_minor);
      }
      return {
        rows: [{
          id: basket.id,
          customer_id: basket.customer_id,
          virtual_card_id: basket.virtual_card_id,
          issuer_connection_id: basket.issuer_connection_id,
          retailer: basket.retailer,
          payment_status: basket.payment_status,
          payment_route: batch.payment_route,
          amount_minor: sumAmount
        }],
        rowCount: 1
      };
    }

    // Existing virtual_cards lookup ignoring CLOSED/CANCELLED
    if (normalized.includes("from virtual_cards where tenant_id=$1 and (id=$2 or checkout_basket_id=$3)") ||
        normalized.includes("from virtual_cards vc where vc.tenant_id=$1 and vc.checkout_basket_id=$2")) {
      const tenantId = params[0];
      const cardId = params[1];
      const basketId = params[2] ?? params[1];

      const matching = [...store.virtual_cards.values()].filter(c =>
        c.tenant_id === tenantId &&
        (c.id === cardId || c.checkout_basket_id === basketId) &&
        !["CLOSED", "CANCELLED"].includes(c.status)
      ).sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime());

      return { rows: matching.slice(0, 1), rowCount: matching.length ? 1 : 0 };
    }

    // Single virtual_card lookup by id
    if (normalized.startsWith("select status from virtual_cards where id=$1") ||
        normalized.startsWith("select * from virtual_cards where id=$1")) {
      const id = params[0];
      const card = store.virtual_cards.get(id);
      return { rows: card ? [card] : [], rowCount: card ? 1 : 0 };
    }

    // Unique constraint duplicate lookup on conflict:
    if (normalized.includes("select * from virtual_cards where tenant_id=$1 and checkout_basket_id=$2 and status not in ('CLOSED','CANCELLED')")) {
      const tenantId = params[0];
      const basketId = params[1];
      const matching = [...store.virtual_cards.values()].filter(c =>
        c.tenant_id === tenantId &&
        c.checkout_basket_id === basketId &&
        !["CLOSED", "CANCELLED"].includes(c.status)
      );
      return { rows: matching.slice(0, 1), rowCount: matching.length ? 1 : 0 };
    }

    // Insert virtual_card
    if (normalized.startsWith("insert into virtual_cards")) {
      const basketId = params[6];
      const tenantId = params[0];
      // Check partial unique index constraint: only 1 non-closed/cancelled card per basket
      const existing = [...store.virtual_cards.values()].find(c =>
        c.tenant_id === tenantId &&
        c.checkout_basket_id === basketId &&
        !["CLOSED", "CANCELLED"].includes(c.status)
      );
      if (existing) {
        const err: any = new Error("duplicate key value violates unique constraint");
        err.code = "23505";
        throw err;
      }
      const id = String(++cardIdCounter);
      const row = {
        id,
        tenant_id: params[0],
        provider: "pending",
        provider_card_id: params[1],
        provider_account_id: null,
        label: params[2],
        masked_number: null,
        status: "PENDING_ISSUE",
        balance_minor: 0,
        merchant_control: params[3],
        created_by: params[4],
        customer_id: params[5],
        checkout_basket_id: basketId,
        issuer_connection_id: params[7],
        merchant_scope_type: "RETAILER",
        merchant_scope_value: params[8],
        channel_control_status: "NOT_APPLIED",
        created_at: new Date().toISOString(),
        issuing_started_at: null
      };
      store.virtual_cards.set(id, row);
      return { rows: [row], rowCount: 1 };
    }

    // Atomic claim: update virtual_cards set status='ISSUING', issuing_started_at=now() where id=$1 and status='PENDING_ISSUE' and provider_card_id like 'PENDING:%' returning *
    if (normalized.includes("set status='ISSUING'") && normalized.includes("where id=$1 and status='PENDING_ISSUE'")) {
      const id = params[0];
      const card = store.virtual_cards.get(id);
      if (card && card.status === "PENDING_ISSUE" && String(card.provider_card_id).startsWith("PENDING:")) {
        card.status = "ISSUING";
        card.issuing_started_at = new Date().toISOString();
        card.updated_at = new Date().toISOString();
        return { rows: [card], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    // Update virtual_cards after createCard (set provider, provider_card_id, ... where id=$6 and status='ISSUING' returning *)
    if (normalized.includes("where id=$6 and status='ISSUING'") || (normalized.includes("set provider=$1") && normalized.includes("returning *"))) {
      const id = params[5];
      const card = store.virtual_cards.get(id);
      if (card && card.status === "ISSUING") {
        card.provider = params[0];
        card.provider_card_id = params[1];
        card.provider_account_id = params[2];
        card.masked_number = params[3];
        card.issuer_connection_id = params[4];
        card.status = "PENDING_ISSUE";
        card.issuing_started_at = null;
        card.updated_at = new Date().toISOString();
        return { rows: [card], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    // Rollback claim on createCard failure: update virtual_cards set status='PENDING_ISSUE',issuing_started_at=null where id=$1 and status='ISSUING'
    if (normalized.includes("set status='PENDING_ISSUE'") && normalized.includes("where id=$1 and status='ISSUING'")) {
      const id = params[0];
      const card = store.virtual_cards.get(id);
      if (card && card.status === "ISSUING") {
        card.status = "PENDING_ISSUE";
        card.issuing_started_at = null;
        card.updated_at = new Date().toISOString();
        return { rows: [card], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    // Update status to ISSUE_UNCERTAIN
    if (normalized.includes("set status='ISSUE_UNCERTAIN'")) {
      const id = params[0];
      const card = store.virtual_cards.get(id);
      if (card) {
        card.status = "ISSUE_UNCERTAIN";
        card.updated_at = new Date().toISOString();
        return { rows: [card], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    // Update status to CLEANUP_REQUIRED
    if (normalized.includes("set status='CLEANUP_REQUIRED'")) {
      const id = params[0];
      const card = store.virtual_cards.get(id);
      if (card) {
        card.status = "CLEANUP_REQUIRED";
        card.updated_at = new Date().toISOString();
        return { rows: [card], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    // Update status to CLOSED
    if (normalized.includes("set status='CLOSED'")) {
      const id = params[0];
      const card = store.virtual_cards.get(id);
      if (card) {
        card.status = "CLOSED";
        card.balance_minor = 0;
        card.updated_at = new Date().toISOString();
        return { rows: [card], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    // Update channel_control_status & CONTROL_FAILED
    if (normalized.includes("set channel_control_status='NOT_SUPPORTED',status='CONTROL_FAILED'")) {
      const id = params[0];
      const card = store.virtual_cards.get(id);
      if (card) {
        card.channel_control_status = "NOT_SUPPORTED";
        card.status = "CONTROL_FAILED";
        card.updated_at = new Date().toISOString();
        return { rows: [card], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    // Update channel_control_status
    if (normalized.includes("set channel_control_status=$1")) {
      const status = params[0];
      const id = params[1];
      const card = store.virtual_cards.get(id);
      if (card) {
        card.channel_control_status = status;
        card.updated_at = new Date().toISOString();
        return { rows: [card], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    // Update balance_minor and status='ACTIVE' on loadCard success
    if (normalized.includes("set balance_minor=greatest(balance_minor,$1),status='ACTIVE'")) {
      const amount = params[0];
      const id = params[1];
      const card = store.virtual_cards.get(id);
      if (card) {
        card.balance_minor = Math.max(Number(card.balance_minor || 0), Number(amount));
        card.status = "ACTIVE";
        card.updated_at = new Date().toISOString();
        return { rows: [card], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    // Update status='LOAD_FAILED'
    if (normalized.includes("set status='LOAD_FAILED'")) {
      const id = params[0];
      const card = store.virtual_cards.get(id);
      if (card) {
        card.status = "LOAD_FAILED";
        card.updated_at = new Date().toISOString();
        return { rows: [card], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    // Checkout basket updates
    if (normalized.startsWith("update checkout_baskets set")) {
      const basketId = params[normalized.includes("virtual_card_id=$1") ? 1 : 0];
      const basket = store.baskets.get(basketId);
      if (basket) {
        if (normalized.includes("virtual_card_id=$1")) {
          basket.virtual_card_id = params[0];
          basket.payment_status = "CARD_ASSIGNED";
        } else if (normalized.includes("payment_status='FAILED'")) {
          basket.payment_status = "FAILED";
        } else if (normalized.includes("payment_status='VERIFICATION_REQUIRED'")) {
          basket.payment_status = "VERIFICATION_REQUIRED";
        } else if (normalized.includes("status='REQUIRES_ACTION'")) {
          basket.status = "REQUIRES_ACTION";
          if (normalized.includes("failure_code='PAYMENT_SETUP_REQUIRED'")) {
            basket.failure_code = "PAYMENT_SETUP_REQUIRED";
          } else if (normalized.includes("failure_code='CARD_SETUP_FAILED'")) {
            basket.failure_code = "CARD_SETUP_FAILED";
            basket.failure_message = params[0];
          }
        }
        basket.updated_at = new Date().toISOString();
        return { rows: [basket], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    // Issuer connections lookup
    if (normalized.includes("from issuer_connections where tenant_id=$1")) {
      const tenantId = params[0];
      const connId = params[1];
      const matching = [...store.issuer_connections.values()].filter(c =>
        c.tenant_id === tenantId &&
        c.status === "CONNECTED" &&
        (!connId || c.id === connId)
      );
      return { rows: matching.slice(0, 1), rowCount: matching.length ? 1 : 0 };
    }

    // Audit log
    if (normalized.startsWith("insert into audit_log")) {
      const log = {
        tenant_id: params[0],
        actor_id: params[1],
        action: params[2],
        entity_type: params[3],
        entity_id: params[4],
        metadata: params[5],
        created_at: new Date().toISOString()
      };
      store.audit_logs.push(log);
      return { rows: [log], rowCount: 1 };
    }

    return { rows: [], rowCount: 0 };
  };

  const db = {
    query: executeQuery,
    connect: async () => ({
      query: executeQuery,
      release: () => {}
    })
  } as unknown as Db;

  return { db, store };
}

// ------------------------------------------------------------------------------------------------
// Section 8.1 Tests: Card Provisioning & Lifecycle Safety
// ------------------------------------------------------------------------------------------------

test("8.1.1: 5 concurrent ensureBasketVirtualCard calls issue exactly one card", async () => {
  const tenantId = "tenant-concurrent";
  const basketId = "basket-concurrent-1";
  const userId = "user-1";

  const { db, store } = createMockDbStore({
    baskets: new Map([[
      basketId,
      {
        id: basketId,
        tenant_id: tenantId,
        customer_id: "cust-1",
        batch_id: "batch-1",
        retailer: "flipkart",
        amount_minor: 100000,
        payment_status: "PENDING"
      }
    ]]),
    batches: new Map([[
      "batch-1",
      { id: "batch-1", payment_route: "Corporate virtual card" }
    ]])
  });

  const encryptedCreds = encryptJson({ directCard: true, last4: "9999" }, TEST_KEY);
  store.issuer_connections.set("conn-direct", {
    id: "conn-direct",
    tenant_id: tenantId,
    provider: "direct_card",
    ciphertext: encryptedCreds.ciphertext,
    iv: encryptedCreds.iv,
    auth_tag: encryptedCreds.authTag,
    status: "CONNECTED",
    integration_mode: "DIRECT_CARD",
    funding_cardholder_name: "Test Holder",
    funding_card_last4: "9999",
    capabilities: { createCard: true, issuerControls: true, loadCard: true }
  });

  const config = createTestConfig();
  let createCardCalls = 0;
  const origCreateCard = DirectCardVirtualCardIssuer.prototype.createCard;
  DirectCardVirtualCardIssuer.prototype.createCard = async function (input: any) {
    createCardCalls++;
    await new Promise(r => setTimeout(r, 40));
    return origCreateCard.call(this, input);
  };

  try {
    // Run 5 concurrent ensureBasketVirtualCard calls
    const results = await Promise.all([
      ensureBasketVirtualCard(db, config, tenantId, basketId, userId),
      ensureBasketVirtualCard(db, config, tenantId, basketId, userId),
      ensureBasketVirtualCard(db, config, tenantId, basketId, userId),
      ensureBasketVirtualCard(db, config, tenantId, basketId, userId),
      ensureBasketVirtualCard(db, config, tenantId, basketId, userId)
    ]);

    // createCard must be called exactly once across all 5 concurrent attempts
    assert.equal(createCardCalls, 1, "createCard should be called exactly once");

    // All 5 should return valid non-failing results (CARD_ASSIGNED or ISSUE_IN_PROGRESS)
    for (const res of results) {
      assert.ok(
        res.status === "CARD_ASSIGNED" || res.status === "ISSUE_IN_PROGRESS",
        `Expected status CARD_ASSIGNED or ISSUE_IN_PROGRESS, got ${res.status}`
      );
    }

    // Calling once more after completion must immediately return CARD_ASSIGNED with the active card
    const followUp = await ensureBasketVirtualCard(db, config, tenantId, basketId, userId);
    assert.equal(followUp.status, "CARD_ASSIGNED");

    // Exactly one row exists in virtual_cards, with ACTIVE status
    const cards = [...store.virtual_cards.values()].filter(c => c.checkout_basket_id === basketId);
    assert.equal(cards.length, 1);
    assert.equal(cards[0].status, "ACTIVE");
    assert.equal(cards[0].balance_minor, 100000);
  } finally {
    DirectCardVirtualCardIssuer.prototype.createCard = origCreateCard;
  }
});

test("8.1.2: Retry after LOAD_FAILED re-runs configureCard and loadCard without calling createCard", async () => {
  const tenantId = "tenant-retry";
  const basketId = "basket-retry-1";
  const userId = "user-1";
  const cardId = "card-retry-existing";

  const { db, store } = createMockDbStore({
    baskets: new Map([[
      basketId,
      {
        id: basketId,
        tenant_id: tenantId,
        customer_id: "cust-1",
        batch_id: "batch-1",
        retailer: "amazon-in",
        amount_minor: 50000,
        payment_status: "FAILED",
        virtual_card_id: cardId
      }
    ]]),
    batches: new Map([[
      "batch-1",
      { id: "batch-1", payment_route: "Corporate virtual card" }
    ]]),
    virtual_cards: new Map([[
      cardId,
      {
        id: cardId,
        tenant_id: tenantId,
        provider: "direct_card",
        provider_card_id: "vcard_existing",
        provider_account_id: "acc_existing",
        masked_number: "•••• •••• •••• 1234",
        status: "LOAD_FAILED",
        balance_minor: 0,
        checkout_basket_id: basketId,
        created_at: new Date(Date.now() - 60000).toISOString()
      }
    ]])
  });

  const encryptedCreds = encryptJson({ directCard: true, last4: "1234" }, TEST_KEY);
  store.issuer_connections.set("conn-direct", {
    id: "conn-direct",
    tenant_id: tenantId,
    provider: "direct_card",
    ciphertext: encryptedCreds.ciphertext,
    iv: encryptedCreds.iv,
    auth_tag: encryptedCreds.authTag,
    status: "CONNECTED",
    integration_mode: "DIRECT_CARD",
    funding_cardholder_name: "Test Holder",
    funding_card_last4: "1234",
    capabilities: { createCard: true, issuerControls: true, loadCard: true }
  });

  const config = createTestConfig();
  let createCardCalls = 0;
  let configureCardCalls = 0;
  let loadCardCalls = 0;

  const origCreateCard = DirectCardVirtualCardIssuer.prototype.createCard;
  const origConfigureCard = DirectCardVirtualCardIssuer.prototype.configureCard;
  const origLoadCard = DirectCardVirtualCardIssuer.prototype.loadCard;

  DirectCardVirtualCardIssuer.prototype.createCard = async function (input: any) {
    createCardCalls++;
    return origCreateCard.call(this, input);
  };
  DirectCardVirtualCardIssuer.prototype.configureCard = async function (input: any) {
    configureCardCalls++;
    return origConfigureCard.call(this, input);
  };
  DirectCardVirtualCardIssuer.prototype.loadCard = async function (input: any) {
    loadCardCalls++;
    return origLoadCard.call(this, input);
  };

  try {
    const res = await ensureBasketVirtualCard(db, config, tenantId, basketId, userId);

    assert.equal(res.status, "CARD_ASSIGNED");
    assert.equal(res.cardId, cardId);
    assert.equal(createCardCalls, 0, "createCard must NOT be called for already issued card");
    assert.equal(configureCardCalls, 1, "configureCard must be re-run on retry");
    assert.equal(loadCardCalls, 1, "loadCard must be re-run on retry");

    const card = store.virtual_cards.get(cardId);
    assert.equal(card.status, "ACTIVE");
    assert.equal(card.balance_minor, 50000);
  } finally {
    DirectCardVirtualCardIssuer.prototype.createCard = origCreateCard;
    DirectCardVirtualCardIssuer.prototype.configureCard = origConfigureCard;
    DirectCardVirtualCardIssuer.prototype.loadCard = origLoadCard;
  }
});

test("8.1.3: configureCard NOT_SUPPORTED moves basket to FAILED and card to CONTROL_FAILED without calling loadCard", async () => {
  const tenantId = "tenant-control";
  const basketId = "basket-control-1";
  const userId = "user-1";

  const { db, store } = createMockDbStore({
    baskets: new Map([[
      basketId,
      {
        id: basketId,
        tenant_id: tenantId,
        customer_id: "cust-1",
        batch_id: "batch-1",
        retailer: "flipkart",
        amount_minor: 50000,
        payment_status: "PENDING"
      }
    ]]),
    batches: new Map([[
      "batch-1",
      { id: "batch-1", payment_route: "Corporate virtual card" }
    ]])
  });

  const bankCreds = {
    bankCode: "testbank",
    baseUrl: "https://mock.bank.com",
    authMode: "API_KEY",
    apiKey: "key",
    parentAccountReference: "parent",
    createCardPath: "/cards/create",
    createCardTemplate: "{}",
    responseCardIdPath: "cardId"
  };
  const encryptedCreds = encryptJson(bankCreds, TEST_KEY);

  store.issuer_connections.set("conn-bank", {
    id: "conn-bank",
    tenant_id: tenantId,
    provider: "testbank",
    ciphertext: encryptedCreds.ciphertext,
    iv: encryptedCreds.iv,
    auth_tag: encryptedCreds.authTag,
    status: "CONNECTED",
    bank_code: "testbank",
    capabilities: { createCard: true, issuerControls: true, loadCard: true, controls_optional: false }
  });

  const origFetch = globalThis.fetch;
  let loadCardCalled = false;
  globalThis.fetch = async (input: any) => {
    const url = String(input);
    if (url.includes("/cards/create")) {
      return new Response(JSON.stringify({ cardId: "vcard_test_ctrl_1" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    loadCardCalled = true;
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };

  const config = createTestConfig();
  try {
    const res = await ensureBasketVirtualCard(db, config, tenantId, basketId, userId);

    assert.equal(res.status, "CONTROL_FAILED");
    assert.equal(loadCardCalled, false, "loadCard must NOT be called when configureCard returns NOT_SUPPORTED");

    const basket = store.baskets.get(basketId);
    assert.equal(basket.payment_status, "FAILED");

    const cards = [...store.virtual_cards.values()].filter(c => c.checkout_basket_id === basketId);
    assert.equal(cards.length, 1);
    assert.equal(cards[0].status, "CONTROL_FAILED");
    assert.equal(cards[0].channel_control_status, "NOT_SUPPORTED");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("8.1.4: Funding cap exceeded rejects request, logs audit, and does not create card", async () => {
  const tenantId = "tenant-funding";
  const basketId = "basket-funding-1";
  const userId = "user-1";

  const { db, store } = createMockDbStore({
    baskets: new Map([[
      basketId,
      {
        id: basketId,
        tenant_id: tenantId,
        customer_id: "cust-1",
        batch_id: "batch-1",
        retailer: "flipkart",
        amount_minor: 100000, // 1000 INR
        payment_status: "PENDING"
      }
    ]]),
    batches: new Map([[
      "batch-1",
      { id: "batch-1", payment_route: "Corporate virtual card" }
    ]])
  });

  const encryptedCreds = encryptJson({ directCard: true, last4: "9999" }, TEST_KEY);
  store.issuer_connections.set("conn-direct", {
    id: "conn-direct",
    tenant_id: tenantId,
    provider: "direct_card",
    ciphertext: encryptedCreds.ciphertext,
    iv: encryptedCreds.iv,
    auth_tag: encryptedCreds.authTag,
    status: "CONNECTED",
    integration_mode: "DIRECT_CARD",
    funding_cardholder_name: "Test Holder",
    funding_card_last4: "9999",
    capabilities: { createCard: true, issuerControls: true, loadCard: true }
  });

  const config = createTestConfig({ CARD_FUNDING_MAX_OVERAGE_PCT: 10 });

  // 1500 INR requested on 1000 INR order (exceeds 10% cap of 1100 INR)
  const res = await ensureBasketVirtualCard(db, config, tenantId, basketId, userId, 150000);

  assert.equal(res.status, "FUNDING_CAP_EXCEEDED");
  assert.equal(res.cardId, null);

  const basket = store.baskets.get(basketId);
  assert.equal(basket.payment_status, "FAILED");

  const auditLogs = store.audit_logs.filter(a => a.action === "virtual_card.funding_cap_exceeded");
  assert.equal(auditLogs.length, 1);
  assert.equal(auditLogs[0].metadata.expectedMinor, 100000);
  assert.equal(auditLogs[0].metadata.requestedMinor, 150000);
  assert.equal(auditLogs[0].metadata.hardCeiling, 110000);
});

test("8.1.5: cleanupBasketVirtualCard transitions to CLEANUP_REQUIRED when closeCard fails", async () => {
  const tenantId = "tenant-cleanup";
  const basketId = "basket-cleanup-1";
  const userId = "user-1";
  const cardId = "card-cleanup-1";

  const { db, store } = createMockDbStore({
    baskets: new Map([[
      basketId,
      {
        id: basketId,
        tenant_id: tenantId,
        customer_id: "cust-1",
        batch_id: "batch-1",
        retailer: "flipkart",
        amount_minor: 100000,
        payment_status: "CARD_ASSIGNED",
        virtual_card_id: cardId
      }
    ]]),
    batches: new Map([[
      "batch-1",
      { id: "batch-1", payment_route: "Corporate virtual card" }
    ]]),
    virtual_cards: new Map([[
      cardId,
      {
        id: cardId,
        tenant_id: tenantId,
        provider: "enkash",
        provider_card_id: "vcard_cleanup_1",
        provider_account_id: "acc_1",
        masked_number: "•••• •••• •••• 5555",
        status: "ACTIVE",
        balance_minor: 100000,
        checkout_basket_id: basketId,
        issuer_connection_id: "conn-enkash",
        created_at: new Date().toISOString()
      }
    ]])
  });

  // Setup EnKash connection without closeCard method supported or with error
  const enkashCreds = {
    ENKASH_BASE_URL: "https://mock.enkash.com",
    ENKASH_TOKEN_URL: "https://mock.enkash.com/oauth/token",
    ENKASH_PARTNER_ID: "partner123",
    ENKASH_BASIC_AUTH: "YmFzaWM6YXV0aA==",
    ENKASH_USERNAME: "user1",
    ENKASH_PASSWORD: "pass1",
    ENKASH_CLIENT_ID: "client1",
    ENKASH_COMPANY_ID: "comp1",
    ENKASH_CARD_ACCOUNT_ID: "acc1"
  };
  const encryptedCreds = encryptJson(enkashCreds, TEST_KEY);

  store.issuer_connections.set("conn-enkash", {
    id: "conn-enkash",
    tenant_id: tenantId,
    provider: "enkash",
    ciphertext: encryptedCreds.ciphertext,
    iv: encryptedCreds.iv,
    auth_tag: encryptedCreds.authTag,
    status: "CONNECTED",
    capabilities: { createCard: true, issuerControls: true, loadCard: true }
  });

  const config = createTestConfig();
  const cleanupRes = await cleanupBasketVirtualCard(db, config, tenantId, basketId, userId);

  assert.equal(cleanupRes.cleaned, false);
  const card = store.virtual_cards.get(cardId);
  assert.equal(card.status, "CLEANUP_REQUIRED", "Card must be CLEANUP_REQUIRED and never CLOSED when closeCard cannot be confirmed");

  const auditLogs = store.audit_logs.filter(a => a.action === "virtual_card.cleanup_failed");
  assert.equal(auditLogs.length, 1);
});

test("8.1.6: Closed card replaced on retry without violating unique constraints", async () => {
  const tenantId = "tenant-closed-replace";
  const basketId = "basket-closed-1";
  const userId = "user-1";
  const closedCardId = "card-closed-old";

  const { db, store } = createMockDbStore({
    baskets: new Map([[
      basketId,
      {
        id: basketId,
        tenant_id: tenantId,
        customer_id: "cust-1",
        batch_id: "batch-1",
        retailer: "flipkart",
        amount_minor: 80000,
        payment_status: "PENDING",
        virtual_card_id: closedCardId
      }
    ]]),
    batches: new Map([[
      "batch-1",
      { id: "batch-1", payment_route: "Corporate virtual card" }
    ]]),
    virtual_cards: new Map([[
      closedCardId,
      {
        id: closedCardId,
        tenant_id: tenantId,
        provider: "direct_card",
        provider_card_id: "vcard_closed_old",
        status: "CLOSED",
        balance_minor: 0,
        checkout_basket_id: basketId,
        created_at: new Date(Date.now() - 3600000).toISOString()
      }
    ]])
  });

  const encryptedCreds = encryptJson({ directCard: true, last4: "8888" }, TEST_KEY);
  store.issuer_connections.set("conn-direct", {
    id: "conn-direct",
    tenant_id: tenantId,
    provider: "direct_card",
    ciphertext: encryptedCreds.ciphertext,
    iv: encryptedCreds.iv,
    auth_tag: encryptedCreds.authTag,
    status: "CONNECTED",
    integration_mode: "DIRECT_CARD",
    funding_cardholder_name: "Test Holder",
    funding_card_last4: "8888",
    capabilities: { createCard: true, issuerControls: true, loadCard: true }
  });

  const config = createTestConfig();
  const res = await ensureBasketVirtualCard(db, config, tenantId, basketId, userId);

  assert.equal(res.status, "CARD_ASSIGNED");
  assert.notEqual(res.cardId, closedCardId, "A fresh card must be issued rather than reusing the closed card");

  const oldCard = store.virtual_cards.get(closedCardId);
  assert.equal(oldCard.status, "CLOSED");

  const newCard = store.virtual_cards.get(res.cardId!);
  assert.equal(newCard.status, "ACTIVE");
  assert.equal(newCard.checkout_basket_id, basketId);
});

// ------------------------------------------------------------------------------------------------
// Section 8.2 Tests: applyBasketCardProvisioning Helper Status Handling
// ------------------------------------------------------------------------------------------------

test("8.2: applyBasketCardProvisioning correctly handles all provision status codes", async () => {
  const tenantId = "tenant-apply";
  const userId = "user-1";
  const config = createTestConfig();

  // 1. NOT_REQUIRED (payment_route is NOT Corporate virtual card)
  {
    const basketId = "basket-route-personal";
    const { db, store } = createMockDbStore({
      baskets: new Map([[
        basketId,
        { id: basketId, tenant_id: tenantId, customer_id: "c1", batch_id: "b1", retailer: "flipkart", amount_minor: 1000 }
      ]]),
      batches: new Map([[
        "b1",
        { id: "b1", payment_route: "Personal account card" }
      ]])
    });

    const res = await applyBasketCardProvisioning(db, config, tenantId, basketId, userId, 1000);
    assert.deepEqual(res, { cardId: null, assigned: false, inProgress: false });
  }

  // 2. PROGRAMME_REQUIRED (issuer not configured)
  {
    const basketId = "basket-no-issuer";
    const { db, store } = createMockDbStore({
      baskets: new Map([[
        basketId,
        { id: basketId, tenant_id: tenantId, customer_id: "c1", batch_id: "b1", retailer: "flipkart", amount_minor: 1000 }
      ]]),
      batches: new Map([[
        "b1",
        { id: "b1", payment_route: "Corporate virtual card" }
      ]])
    });

    const res = await applyBasketCardProvisioning(db, config, tenantId, basketId, userId, 1000);
    assert.deepEqual(res, { cardId: null, assigned: false, inProgress: false });
    const b = store.baskets.get(basketId);
    assert.equal(b.status, "REQUIRES_ACTION");
    assert.equal(b.failure_code, "PAYMENT_SETUP_REQUIRED");
  }

  // 3. CARD_ASSIGNED
  {
    const basketId = "basket-assigned";
    const cardId = "card-active-ready";
    const { db, store } = createMockDbStore({
      baskets: new Map([[
        basketId,
        { id: basketId, tenant_id: tenantId, customer_id: "c1", batch_id: "b1", retailer: "flipkart", amount_minor: 5000, virtual_card_id: cardId }
      ]]),
      batches: new Map([[
        "b1",
        { id: "b1", payment_route: "Corporate virtual card" }
      ]]),
      virtual_cards: new Map([[
        cardId,
        { id: cardId, tenant_id: tenantId, status: "ACTIVE", balance_minor: 5000, checkout_basket_id: basketId }
      ]])
    });

    const res = await applyBasketCardProvisioning(db, config, tenantId, basketId, userId, 5000);
    assert.deepEqual(res, { cardId, assigned: true, inProgress: false });
  }
});

test("EnKash cardholder creates appropriate gender title", async () => {
  let requestPayload: any = null;
  const mockConfig = {
    ENKASH_BASE_URL: "https://mock.enkash.com",
    ENKASH_TOKEN_URL: "https://mock.enkash.com/oauth/token",
    ENKASH_PARTNER_ID: "partner123",
    ENKASH_BASIC_AUTH: "YmFzaWM6YXV0aA==",
    ENKASH_USERNAME: "user1",
    ENKASH_PASSWORD: "pass1",
    ENKASH_CLIENT_ID: "client1",
    ENKASH_COMPANY_ID: "comp1",
    ENKASH_CARD_ACCOUNT_ID: "acc1"
  } as Config;

  const issuer = new EnKashVirtualCardIssuer(mockConfig);
  // @ts-expect-error Mocking private request method for unit test
  issuer.request = async (_path: string, body: object) => {
    requestPayload = body;
    return { enKashCardId: "card_123", cardAccountId: "acc1", cardStatus: { label: "ACTIVE" }, otbBalance: 1000 };
  };

  await issuer.createCard({
    cardholder: {
      email: "jane@example.com",
      mobile: "9876543210",
      firstName: "Jane",
      lastName: "Doe",
      gender: "F",
      pan: "ABCDE1234F",
      specialDate: "01-01-1995"
    }
  });
  assert.equal(requestPayload.title, "Ms");

  await issuer.createCard({
    cardholder: {
      email: "john@example.com",
      mobile: "9876543211",
      firstName: "John",
      lastName: "Doe",
      gender: "M",
      pan: "ABCDE1234M",
      specialDate: "01-01-1990"
    }
  });
  assert.equal(requestPayload.title, "Mr");
});

test("Generic bank virtual card issuer renders templates and handles control failure", async () => {
  const issuer = new GenericBankVirtualCardIssuer({
    bankCode: "hdfc",
    baseUrl: "https://mock.bank.com",
    authMode: "API_KEY",
    apiKey: "test_key",
    parentAccountReference: "parent_acc_1",
    createCardPath: "/cards/create",
    createCardTemplate: JSON.stringify({ amount: "{{ amountMinor }}", ref: "{{ label }}" }),
    responseCardIdPath: "data.cardId"
  });

  assert.equal(issuer.configured(), true);
  const controlStatus = await issuer.configureCard({
    providerCardId: "card_1",
    providerAccountId: "acc_1",
    onlineAllowed: true,
    posAllowed: false
  });
  assert.equal(controlStatus, "NOT_SUPPORTED");
});

