import test from "node:test";
import assert from "node:assert/strict";
import { retailerForProductUrl, validateRetailerOrderId, verifiedRetailerUrl } from "../src/retailers.js";

test("recognizes supported Indian retailers without accepting lookalike hosts",()=>{
  assert.equal(retailerForProductUrl("https://www.amazon.in/dp/B0TEST").id,"amazon-in");
  assert.equal(retailerForProductUrl("https://www.flipkart.com/item/p/itm1").id,"flipkart");
  assert.throws(()=>retailerForProductUrl("https://amazon.in.attacker.example/dp/B0TEST"));
});

test("supports Shopify-style product paths and requires HTTPS",()=>{
  assert.equal(retailerForProductUrl("https://merchant.example/products/device").id,"store:merchant.example");
  assert.throws(()=>retailerForProductUrl("http://merchant.example/products/device"));
  assert.throws(()=>retailerForProductUrl("https://user:pass@merchant.example/products/device"));
});

test("verified execution URL removes fragments and validates retailer order IDs",()=>{
  assert.equal(verifiedRetailerUrl("https://www.amazon.in/dp/B0TEST#reviews"),"https://www.amazon.in/dp/B0TEST");
  assert.equal(validateRetailerOrderId("OD123-456"),"OD123-456");
  assert.throws(()=>validateRetailerOrderId("<script>"));
});


test("flipkart product candidate accepts canonical product-detail URLs only",()=>{
  assert.equal(flipkartProductCandidateUrl("https://www.flipkart.com/example-phone/p/itm123ABC?pid=MOB123#x"),"https://www.flipkart.com/example-phone/p/itm123ABC?pid=MOB123");
  assert.throws(()=>flipkartProductCandidateUrl("https://www.amazon.in/dp/B0TEST1234"));
  assert.throws(()=>flipkartProductCandidateUrl("https://www.flipkart.com/search?q=phone"));
});
