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
  { city: "Mumbai", state: "Maharashtra", pin: "400001", line1: "101 Nariman Point Business Bay" },
  { city: "Bengaluru", state: "Karnataka", pin: "560001", line1: "42 MG Road, Indiranagar Hub" },
  { city: "New Delhi", state: "Delhi", pin: "110001", line1: "15 Barakhamba Road, Connaught Place" },
  { city: "Hyderabad", state: "Telangana", pin: "500081", line1: "88 Cyber Towers, Madhapur" },
  { city: "Chennai", state: "Tamil Nadu", pin: "600002", line1: "23 Mount Road, Anna Salai" },
  { city: "Pune", state: "Maharashtra", pin: "411001", line1: "76 Koregaon Park South Main Road" },
  { city: "Kolkata", state: "West Bengal", pin: "700001", line1: "5 Park Street, Camac Street" },
  { city: "Ahmedabad", state: "Gujarat", pin: "380015", line1: "12 SG Highway, Bodakdev Tech Park" }
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

DO $$
DECLARE
  v_batch_id uuid := gen_random_uuid();
  v_addr_id uuid;
  v_item_id uuid;
  v_basket_id uuid;
  v_acc_id uuid;
BEGIN
  -- Insert batch
  INSERT INTO order_batches(id, tenant_id, name, status, currency, estimated_total_minor, approved_total_minor, created_by, approved_by, approved_at, payment_route)
  VALUES (v_batch_id, '${tenantId}', 'Apple iPhone 16 Fleet Procurement (40 Units)', 'APPROVED', 'INR', 399600000, 399600000, '${userId}', '${userId}', now(), 'Corporate virtual card');

`;

for (let i = 0; i < 40; i++) {
  const name = names[i];
  const loc = locations[i % locations.length];
  const model = iphoneModels[i % iphoneModels.length];
  const phone = `98${String(10000000 + i * 234567).slice(0, 8)}`;
  const ref = `IPHONE-ORD-${String(i + 1).padStart(3, "0")}`;

  sql += `
  -- Item ${i + 1}: ${name} -> ${model.title}
  v_addr_id := gen_random_uuid();
  INSERT INTO addresses(id, address_book_id, recipient, phone, line1, line2, city, state, postal_code, country, reference)
  VALUES (v_addr_id, '${addressBookId}', '${name.replace(/'/g, "''")}', '${phone}', '${loc.line1.replace(/'/g, "''")} Suite ${101 + i}', 'Floor ${Math.floor(i / 8) + 1}', '${loc.city}', '${loc.state}', '${loc.pin}', 'IN', '${ref}')
  ON CONFLICT (address_book_id, reference) DO UPDATE SET recipient = EXCLUDED.recipient RETURNING id INTO v_addr_id;

  -- Ensure Retailer Account exists
  v_acc_id := gen_random_uuid();
  INSERT INTO retailer_accounts(id, tenant_id, retailer, account_reference, label, auth_status, session_status, session_target_days, active)
  VALUES (v_acc_id, '${tenantId}', 'flipkart', '${phone}', '${name.replace(/'/g, "''")} (${loc.city})', 'READY', 'READY', 30, true)
  ON CONFLICT (tenant_id, retailer, account_reference) DO UPDATE SET session_status = 'READY', auth_status = 'READY' RETURNING id INTO v_acc_id;

  -- Insert Batch Item
  v_item_id := gen_random_uuid();
  INSERT INTO batch_items(id, batch_id, product_url, retailer, title, sku, unit_price_minor, requested_quantity, available_quantity, address_id, pricing_status, retailer_account_id, pricing_checked_at)
  VALUES (v_item_id, v_batch_id, '${model.url}', 'flipkart', '${model.title.replace(/'/g, "''")}', '${model.sku}', ${model.priceMinor}, 1, 1, v_addr_id, 'VERIFIED', v_acc_id, now())
  ON CONFLICT (batch_id, product_url, address_id) DO NOTHING;

  -- Insert Checkout Basket
  v_basket_id := gen_random_uuid();
  INSERT INTO checkout_baskets(id, tenant_id, batch_id, address_id, retailer, status, commercial_status, payment_status, observed_amount_minor, account_reference, retailer_account_id, delivery_estimate, delivery_stock_state, timeline)
  VALUES (v_basket_id, '${tenantId}', v_batch_id, v_addr_id, 'flipkart', 'READY', 'APPROVED', 'PENDING', ${model.priceMinor}, '${ref}', v_acc_id, 'Delivery in 2 days (Express)', 'IN_STOCK', jsonb_build_array(jsonb_build_object('event', 'CREATED', 'at', now())))
  ON CONFLICT (batch_id, address_id, retailer) DO NOTHING;

  -- Insert Purchase Order
  INSERT INTO purchase_orders(tenant_id, batch_item_id, checkout_basket_id, retailer, status, amount_minor, idempotency_key)
  VALUES ('${tenantId}', v_item_id, v_basket_id, 'flipkart', 'QUEUED', ${model.priceMinor}, gen_random_uuid()::text);
`;
}

sql += `
END $$;
COMMIT;
`;

fs.writeFileSync("scripts/seed_40_iphones.sql", sql);
console.log("Regenerated scripts/seed_40_iphones.sql with purchase_orders fix!");
