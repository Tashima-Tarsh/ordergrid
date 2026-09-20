import test from "node:test";
import assert from "node:assert/strict";
import { calculateGstInvoice, calculateGstLine, financialYearForDate, stateCodeForName, validateGstin } from "../src/gst.js";

test("splits intra-state GST into CGST and SGST",()=>{
  const line=calculateGstLine({description:"Device",hsnSac:"8471",quantity:1,amountMinor:11800,gstRate:18,priceIncludesGst:true},"03","03");
  assert.equal(line.taxableMinor,10000);
  assert.equal(line.cgstMinor,900);
  assert.equal(line.sgstMinor,900);
  assert.equal(line.igstMinor,0);
  assert.equal(line.totalMinor,11800);
});

test("uses IGST for inter-state supply",()=>{
  const line=calculateGstLine({description:"Device",hsnSac:"8471",quantity:1,amountMinor:10000,gstRate:18,priceIncludesGst:false},"03","07");
  assert.equal(line.taxableMinor,10000);
  assert.equal(line.igstMinor,1800);
  assert.equal(line.totalMinor,11800);
});

test("supports current tax rates including 40 percent and cess",()=>{
  const invoice=calculateGstInvoice([{description:"Notified item",hsnSac:"9999",quantity:1,amountMinor:14500,gstRate:40,cessRate:5,priceIncludesGst:true}],"03","07");
  assert.equal(invoice.totalMinor,14500);
  assert.equal(invoice.igstMinor,4000);
  assert.equal(invoice.cessMinor,500);
});

test("financial year follows April to March",()=>{
  assert.equal(financialYearForDate(new Date("2026-04-01T00:00:00Z")),"2026-27");
  assert.equal(financialYearForDate(new Date("2027-03-31T00:00:00Z")),"2026-27");
});

test("state and GSTIN helpers",()=>{
  assert.equal(stateCodeForName("Punjab"),"03");
  assert.equal(stateCodeForName("New Delhi"),null);
  assert.equal(validateGstin("03ABCDE1234F1Z5"),true);
  assert.equal(validateGstin("bad"),false);
});
