import test from "node:test";
import assert from "node:assert/strict";
import { buildFlipkartAllocation } from "../src/flipkart-allocation.js";

function account(n:number,maxQuantity:number){
  return {
    retailerAccountId:`account-${n}`,
    addressId:`address-${n}`,
    accountReference:`flip-${n}`,
    productCheckId:`check-${n}`,
    maxQuantity,
    sellingPriceMinor:100000
  };
}

test("allocates 40 units as 20 accounts x 2 when each verified account allows two",()=>{
  const result=buildFlipkartAllocation(Array.from({length:40},(_,i)=>account(i+1,2)),40);
  assert.equal(result.complete,true);
  assert.equal(result.allocatedQuantity,40);
  assert.equal(result.remainingQuantity,0);
  assert.equal(result.allocations.length,20);
  assert.ok(result.allocations.every(x=>x.quantity===2));
});

test("uses heterogeneous verified limits without assuming every account has the same max",()=>{
  const result=buildFlipkartAllocation([account(1,1),account(2,3),account(3,2),account(4,4)],7);
  assert.equal(result.complete,true);
  assert.deepEqual(result.allocations.map(x=>x.quantity),[1,3,2,1]);
});

test("reports insufficient verified capacity without overallocating",()=>{
  const result=buildFlipkartAllocation([account(1,2),account(2,1)],5);
  assert.equal(result.complete,false);
  assert.equal(result.allocatedQuantity,3);
  assert.equal(result.remainingQuantity,2);
  assert.deepEqual(result.allocations.map(x=>x.quantity),[2,1]);
});
