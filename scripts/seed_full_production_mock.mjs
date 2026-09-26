import fs from "node:fs";

const tenantId = "a885eb28-8a80-4441-8f56-b2fe828e2412";
const userId = "a8f87c0b-4988-4cf6-be56-bb513453dc73";
const addressBookId = "c884e77d-6142-46be-ad1a-483758d0f7bf";

const names = [
  "Rahul Sharma", "Priya Patel", "Amit Verma", "Sneha Rao", "Vikram Singh",
  "Neha Gupta", "Arjun Mehta", "Ananya Reddy", "Rohan Nair", "Pooja Joshi",
  "Karan Malhotra", "Divya Deshmukh", "Siddharth Iyer", "Kavita Sen", "Manish Kumar",
  "Tanvi Kulkarni", "Aditya Bhat", "Ritu Agrawal", "Nikhil Chopra", "Meera Pillai",
  "Gaurav Saxena", "Swati Mishra", "Harsh Vardhan", "Ishita Bose", "Suresh Menon",
  "Shreya Das", "Vivek Jain", "Deepika Roy", "Pranav Hegde", "Aarti Pandey",
  "Tarun Kapoor", "Sanjana Pillai", "Ashish Trivedi", "Kiran Yadav", "Rajesh Nambiar",
  "Pallavi Ghosh", "Sunil Chawla", "Bhavna Mittal", "Varun Shenoy", "Nandini Ranganathan"
];

const locations = [
  { city: "Mumbai", state: "Maharashtra", stateCode: "27", pin: "400001", line1: "101 Nariman Point Business Bay" },
  { city: "Bengaluru", state: "Karnataka", stateCode: "29", pin: "560001", line1: "42 MG Road, Indiranagar Hub" },
  { city: "New Delhi", state: "Delhi", stateCode: "07", pin: "110001", line1: "15 Barakhamba Road, Connaught Place" },
  { city: "Hyderabad", state: "Telangana", stateCode: "36", pin: "500081", line1: "88 Cyber Towers, Madhapur" },
  { city: "Chennai", state: "Tamil Nadu", stateCode: "33", pin: "600002", line1: "23 Mount Road, Anna Salai" },
  { city: "Pune", state: "Maharashtra", stateCode: "27", pin: "411001", line1: "76 Koregaon Park South Main Road" },
  { city: "Kolkata", state: "West Bengal", stateCode: "19", pin: "700001", line1: "5 Park Street, Camac Street" },
  { city: "Ahmedabad", state: "Gujarat", stateCode: "24", pin: "380015", line1: "12 SG Highway, Bodakdev Tech Park" }
];

const iphoneModels = [
  {
    title: "Apple iPhone 16 (Ultramarine, 128 GB)",
    url: "https://www.flipkart.com/apple-iphone-16-ultramarine-128-gb/p/itm60bf803b9b469",
    priceMinor: 7990000, // ₹79,900
    sku: "IPHONE-16-128-ULTRA"
  },
  {
    title: "Apple iPhone 16 Pro (Desert Titanium, 128 GB)",
    url: "https://www.flipkart.com/apple-iphone-16-pro-desert-titanium-128-gb/p/itm0b2131976a457",
    priceMinor: 11990000, // ₹1,19,900
    sku: "IPHONE-16-PRO-128-DESERT"
  },
  {
    title: "Apple iPhone 16 (Black, 128 GB)",
    url: "https://www.flipkart.com/apple-iphone-16-black-128-gb/p/itm4c424a49c9511",
    priceMinor: 7990000, // ₹79,900
    sku: "IPHONE-16-128-BLK"
  },
  {
    title: "Apple iPhone 16 Pro Max (Natural Titanium, 256 GB)",
    url: "https://www.flipkart.com/apple-iphone-16-pro-max-natural-titanium-256-gb/p/itmd5c928fa8e573",
    priceMinor: 14490000, // ₹1,44,900
    sku: "IPHONE-16-PROMAX-256-NAT"
  }
];

let sql = `
BEGIN;

-- 0. Clean prior test batches to maintain exact 40 items
DELETE FROM gst_invoices WHERE tenant_id = '${tenantId}';
DELETE FROM retailer_order_observations WHERE tenant_id = '${tenantId}';
DELETE FROM purchase_orders WHERE tenant_id = '${tenantId}';
DELETE FROM checkout_baskets WHERE tenant_id = '${tenantId}';
DELETE FROM batch_items WHERE batch_id IN (SELECT id FROM order_batches WHERE tenant_id = '${tenantId}');
DELETE FROM order_batches WHERE tenant_id = '${tenantId}';

-- 1. GST Profile Setup
INSERT INTO gst_profiles(tenant_id, legal_name, trade_name, gstin, address_line1, city, state, state_code, postal_code, invoice_prefix, updated_by, updated_at)
VALUES (
  '${tenantId}',
  'OrderGrid Technologies India Private Limited',
  'OrderGrid Enterprise',
  '27AAFCO1234F1Z5',
  'Tower 2, Level 14, One International Center, Senapati Bapat Marg',
  'Mumbai',
  'Maharashtra',
  '27',
  '400001',
  'OG',
  '${userId}',
  now()
)
ON CONFLICT (tenant_id) DO UPDATE SET
  legal_name = EXCLUDED.legal_name,
  trade_name = EXCLUDED.trade_name,
  gstin = EXCLUDED.gstin,
  address_line1 = EXCLUDED.address_line1,
  city = EXCLUDED.city,
  state = EXCLUDED.state,
  state_code = EXCLUDED.state_code,
  postal_code = EXCLUDED.postal_code;

-- 2. Funding Programme (Issuer Connection)
DO $$
DECLARE
  v_issuer_id uuid := gen_random_uuid();
  v_batch_id uuid := gen_random_uuid();
  v_addr_id uuid;
  v_item_id uuid;
  v_basket_id uuid;
  v_card_id uuid;
  v_acc_id uuid;
  v_inv_id uuid;
  v_order_id text;
  v_taxable bigint;
  v_cgst bigint;
  v_sgst bigint;
  v_igst bigint;
BEGIN
  -- Insert Issuer Connection
  INSERT INTO issuer_connections(
    id, tenant_id, provider, ciphertext, iv, auth_tag, status, connected_by, bank_name, programme_name, card_network, bank_code, integration_mode, funding_cardholder_name, funding_card_last4, funding_card_expiry_month, funding_card_expiry_year
  )
  VALUES (
    v_issuer_id,
    '${tenantId}',
    'hdfc',
    '\\x01020304',
    '\\x05060708',
    '\\x090a0b0c',
    'CONNECTED',
    '${userId}',
    'HDFC Bank',
    'SmartHub Commercial Procurement',
    'Visa Commercial',
    'HDFC',
    'ISSUER_PROGRAMME',
    'OrderGrid Operations',
    '9412',
    12,
    2028
  )
  ON CONFLICT (tenant_id, provider) DO UPDATE SET
    status = 'CONNECTED',
    bank_name = EXCLUDED.bank_name,
    programme_name = EXCLUDED.programme_name,
    funding_cardholder_name = EXCLUDED.funding_cardholder_name,
    funding_card_last4 = EXCLUDED.funding_card_last4
  RETURNING id INTO v_issuer_id;

  -- 3. Create Main Approved Batch
  INSERT INTO order_batches(id, tenant_id, name, status, currency, estimated_total_minor, approved_total_minor, created_by, approved_by, approved_at, payment_route)
  VALUES (v_batch_id, '${tenantId}', 'Apple iPhone 16 Fleet Procurement (40 Units)', 'APPROVED', 'INR', 399600000, 399600000, '${userId}', '${userId}', now(), 'Corporate virtual card');

`;

for (let i = 0; i < 40; i++) {
  const name = names[i];
  const loc = locations[i % locations.length];
  const model = iphoneModels[i % iphoneModels.length];
  const phone = `98${String(10000000 + i * 234567).slice(0, 8)}`;
  const ref = `IPHONE-ORD-${String(i + 1).padStart(3, "0")}`;
  const isConfirmed = i < 26; // 26 Confirmed checkout orders
  const isClaimed = i >= 26 && i < 34; // 8 In-flight checkout orders
  const isWaitingStock = i >= 34 && i < 38; // 4 Stock monitoring orders
  const isReady = i >= 38; // 2 Ready in queue orders
  const retailerOrderId = `OD132890123849102${String(i + 1).padStart(3, "0")}`;
  const invoiceNum = `OG-INV-2026-${String(i + 1).padStart(4, "0")}`;
  const isIntraState = loc.stateCode === "27"; // Maharashtra is intra-state (CGST + SGST)

  const basketStatus = isConfirmed ? 'CONFIRMED' : (isClaimed ? 'CLAIMED' : (isWaitingStock ? 'WAITING_STOCK' : 'READY'));
  const paymentStatus = isConfirmed ? 'CONFIRMED' : (isClaimed ? 'CARD_ASSIGNED' : 'PENDING');
  const deliveryStatus = isConfirmed ? 'Delivered via Ekart Express · Verified' : (isClaimed ? 'In Checkout · Address & Cart Verified' : (isWaitingStock ? 'Monitoring Stock · Auto-Order Enabled' : 'Ready in Checkout Queue'));

  sql += `
  -- Item ${i + 1}: ${name} (${loc.city})
  v_addr_id := gen_random_uuid();
  INSERT INTO addresses(id, address_book_id, recipient, phone, line1, line2, city, state, postal_code, country, reference)
  VALUES (v_addr_id, '${addressBookId}', '${name.replace(/'/g, "''")}', '${phone}', '${loc.line1.replace(/'/g, "''")} Suite ${101 + i}', 'Floor ${Math.floor(i / 8) + 1}', '${loc.city}', '${loc.state}', '${loc.pin}', 'IN', '${ref}')
  ON CONFLICT (address_book_id, reference) DO UPDATE SET recipient = EXCLUDED.recipient, line1 = EXCLUDED.line1 RETURNING id INTO v_addr_id;

  -- Retailer Account
  v_acc_id := gen_random_uuid();
  INSERT INTO retailer_accounts(id, tenant_id, retailer, account_reference, label, auth_status, session_status, session_target_days, active, reward_balance_observed)
  VALUES (v_acc_id, '${tenantId}', 'flipkart', '${phone}', '${name.replace(/'/g, "''")} (${loc.city})', 'READY', 'READY', 30, true, ${(i + 1) * 35})
  ON CONFLICT (tenant_id, retailer, account_reference) DO UPDATE SET session_status = 'READY', auth_status = 'READY', reward_balance_observed = EXCLUDED.reward_balance_observed RETURNING id INTO v_acc_id;

  -- Virtual Card
  v_card_id := gen_random_uuid();
  INSERT INTO virtual_cards(id, tenant_id, provider, provider_card_id, label, masked_number, status, balance_minor, currency, merchant_scope_type, merchant_scope_value, issuer_connection_id)
  VALUES (v_card_id, '${tenantId}', 'hdfc', 'HDFC-VC-${String(1000 + i + 1)}', 'HDFC Virtual Card (${ref})', '4111 89•• •••• ${String(1000 + i + 1)}', '${isConfirmed ? "CLOSED" : "ACTIVE"}', ${model.priceMinor}, 'INR', 'RETAILER', 'flipkart', v_issuer_id)
  ON CONFLICT (tenant_id, provider, provider_card_id) DO UPDATE SET status = EXCLUDED.status RETURNING id INTO v_card_id;

  -- Batch Item
  v_item_id := gen_random_uuid();
  INSERT INTO batch_items(id, batch_id, product_url, retailer, title, sku, unit_price_minor, requested_quantity, available_quantity, address_id, pricing_status, retailer_account_id, pricing_checked_at)
  VALUES (v_item_id, v_batch_id, '${model.url}', 'flipkart', '${model.title.replace(/'/g, "''")}', '${model.sku}', ${model.priceMinor}, 1, 1, v_addr_id, 'VERIFIED', v_acc_id, now());

  -- Checkout Basket
  v_basket_id := gen_random_uuid();
  INSERT INTO checkout_baskets(
    id, tenant_id, batch_id, address_id, retailer, status, commercial_status, payment_status, observed_amount_minor, observed_payable_minor,
    account_reference, retailer_account_id, virtual_card_id, issuer_connection_id, retailer_order_id, confirmed_at, delivery_estimate, delivery_stock_state,
    stock_watch_enabled, stock_watch_auto_order, stock_last_message, timeline
  )
  VALUES (
    v_basket_id,
    '${tenantId}',
    v_batch_id,
    v_addr_id,
    'flipkart',
    '${basketStatus}',
    'APPROVED',
    '${paymentStatus}',
    ${model.priceMinor},
    ${model.priceMinor},
    '${ref}',
    v_acc_id,
    v_card_id,
    v_issuer_id,
    ${isConfirmed ? `'${retailerOrderId}'` : 'NULL'},
    ${isConfirmed ? "now() - interval '2 hours'" : 'NULL'},
    '${deliveryStatus}',
    '${isWaitingStock ? 'RESTOCKING' : 'IN_STOCK'}',
    ${isWaitingStock ? 'true' : 'false'},
    ${isWaitingStock ? 'true' : 'false'},
    ${isWaitingStock ? "'Flipkart seller pool replenishment monitored: Priority allocation scheduled'" : 'NULL'},
    jsonb_build_array(
      jsonb_build_object('event', 'CREATED', 'at', now() - interval '3 hours'),
      jsonb_build_object('event', 'VERIFIED', 'at', now() - interval '2 hours 30 mins'),
      jsonb_build_object('event', 'CHECKOUT_${basketStatus}', 'at', now() - interval '2 hours')
    )
  );

  -- Purchase Order
  INSERT INTO purchase_orders(tenant_id, batch_item_id, checkout_basket_id, retailer, status, amount_minor, retailer_order_id, virtual_card_reference, idempotency_key)
  VALUES (
    '${tenantId}',
    v_item_id,
    v_basket_id,
    'flipkart',
    '${isConfirmed ? "CONFIRMED" : (isClaimed ? "PLACED" : "QUEUED")}',
    ${model.priceMinor},
    ${isConfirmed ? `'${retailerOrderId}'` : 'NULL'},
    '4111 89•• •••• ${String(1000 + i + 1)}',
    gen_random_uuid()::text
  );

  ${isConfirmed ? `
  -- GST Invoice for Confirmed Order ${i + 1}
  v_taxable := round((${model.priceMinor}::numeric / 1.18));
  ${isIntraState ? `
  v_cgst := round((v_taxable * 0.09));
  v_sgst := round((v_taxable * 0.09));
  v_igst := 0;
  ` : `
  v_cgst := 0;
  v_sgst := 0;
  v_igst := ${model.priceMinor} - v_taxable;
  `}

  INSERT INTO gst_invoices(
    id, tenant_id, checkout_basket_id, invoice_number, invoice_date, financial_year, status,
    taxable_minor, cgst_minor, sgst_minor, igst_minor, cess_minor, total_minor,
    place_of_supply_state_code, supplier_snapshot, buyer_snapshot, line_snapshot, created_by
  )
  VALUES (
    gen_random_uuid(),
    '${tenantId}',
    v_basket_id,
    '${invoiceNum}',
    CURRENT_DATE,
    '2025-26',
    'READY',
    v_taxable,
    v_cgst,
    v_sgst,
    v_igst,
    0,
    ${model.priceMinor},
    '${loc.stateCode}',
    jsonb_build_object('name', 'OrderGrid Technologies India Private Limited', 'gstin', '27AAFCO1234F1Z5', 'state', 'Maharashtra', 'state_code', '27'),
    jsonb_build_object('recipient', '${name.replace(/'/g, "''")}', 'city', '${loc.city}', 'state', '${loc.state}', 'pin', '${loc.pin}', 'phone', '${phone}'),
    jsonb_build_array(jsonb_build_object('title', '${model.title.replace(/'/g, "''")}', 'hsn', '85171300', 'qty', 1, 'rate', 18, 'amount', ${model.priceMinor})),
    '${userId}'
  )
  ON CONFLICT (tenant_id, checkout_basket_id) DO NOTHING;

  -- Retailer Observation Record
  INSERT INTO retailer_order_observations(
    tenant_id, retailer_account_id, checkout_basket_id, retailer, retailer_order_id, order_status, observed_at
  )
  VALUES (
    '${tenantId}',
    v_acc_id,
    v_basket_id,
    'flipkart',
    '${retailerOrderId}',
    'CONFIRMED',
    now() - interval '2 hours'
  )
  ON CONFLICT (tenant_id, retailer_account_id, retailer_order_id) DO NOTHING;
  ` : ''}
`;
}

sql += `
END $$;
COMMIT;
`;

fs.writeFileSync("scripts/seed_full_production_mock.sql", sql);
console.log("Regenerated scripts/seed_full_production_mock.sql with valid enum!");
