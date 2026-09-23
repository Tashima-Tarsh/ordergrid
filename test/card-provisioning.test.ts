import test from "node:test";
import assert from "node:assert/strict";
import { EnKashVirtualCardIssuer, type VirtualCardIssuer } from "../src/card-issuer.js";
import { GenericBankVirtualCardIssuer } from "../src/bank-card-issuer.js";
import type { Config } from "../src/config.js";

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

