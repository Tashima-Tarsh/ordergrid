export type FlipkartVerifiedCapacity={
  retailerAccountId:string;
  addressId:string|null;
  accountReference:string;
  customerReference?:string|null;
  recipient?:string|null;
  postalCode?:string|null;
  productCheckId:string;
  maxQuantity:number;
  sellingPriceMinor:number;
  title?:string|null;
  seller?:string|null;
  checkedAt?:string|null;
};

export function buildFlipkartAllocation(accounts:FlipkartVerifiedCapacity[],totalQuantity:number){
  if(!Number.isInteger(totalQuantity)||totalQuantity<1)throw new Error("invalid_total_quantity");
  let remaining=totalQuantity;
  const allocations=accounts.flatMap(account=>{
    if(remaining<=0)return [];
    const maxQuantity=Math.max(0,Math.floor(Number(account.maxQuantity||0)));
    if(maxQuantity<1)return [];
    const quantity=Math.min(maxQuantity,remaining);
    remaining-=quantity;
    return [{...account,quantity}];
  });
  const verifiedCapacity=accounts.reduce((sum,account)=>sum+Math.max(0,Math.floor(Number(account.maxQuantity||0))),0);
  return {
    allocations,
    verifiedCapacity,
    allocatedQuantity:totalQuantity-remaining,
    remainingQuantity:remaining,
    complete:remaining===0
  };
}
