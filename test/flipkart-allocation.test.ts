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

// Required scenario: pool of 40, request 30 — exactly 30 used, 10 accounts stay unused
test("allocates 30 of 40 available accounts when only 30 units requested (one unit per account)",()=>{
  const pool=Array.from({length:40},(_,i)=>account(i+1,1));
  const result=buildFlipkartAllocation(pool,30);
  assert.equal(result.complete,true);
  assert.equal(result.allocatedQuantity,30);
  assert.equal(result.remainingQuantity,0);
  assert.equal(result.allocations.length,30);
  assert.ok(result.allocations.every(x=>x.quantity===1));
  // 10 accounts must be untouched (not in allocations)
  const usedIds=new Set(result.allocations.map(x=>x.retailerAccountId));
  assert.equal(pool.filter(a=>!usedIds.has(a.retailerAccountId)).length,10);
});

// Required scenario: pool of 40, request 45 — must report shortage, not overallocate
test("reports gap when 45 units requested from a 40-account pool (one unit per account)",()=>{
  const pool=Array.from({length:40},(_,i)=>account(i+1,1));
  const result=buildFlipkartAllocation(pool,45);
  assert.equal(result.complete,false);
  assert.equal(result.allocatedQuantity,40);
  assert.equal(result.remainingQuantity,5);
  assert.equal(result.allocations.length,40);
  assert.ok(result.allocations.every(x=>x.quantity===1));
});
