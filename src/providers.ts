export type Quote={title:string;sku?:string;unitPriceMinor:number;currency:"INR";availableQuantity?:number;checkoutMode:"API"|"ORDERGRID_WORKER"};
export interface RetailerProvider{supports(url:string):boolean;quote(url:string):Promise<Quote>}

export class ShopifyProvider implements RetailerProvider{
  supports(url:string){try{const u=new URL(url);return /\/products\//.test(u.pathname)}catch{return false}}
  async quote(url:string):Promise<Quote>{
    const u=new URL(url),handle=u.pathname.split("/products/")[1]?.split("/")[0];
    if(!handle)throw new Error("Invalid Shopify product URL");
    const token=process.env.SHOPIFY_STOREFRONT_TOKEN;
    if(!token)throw new Error("SHOPIFY_STOREFRONT_TOKEN is not configured");
    const res=await fetch(`${u.origin}/api/2025-07/graphql.json`,{method:"POST",headers:{"content-type":"application/json","x-shopify-storefront-access-token":token},body:JSON.stringify({query:`query($handle:String!){product(handle:$handle){title variants(first:1){nodes{id availableForSale quantityAvailable price{amount currencyCode}}}}}`,variables:{handle}})});
    if(!res.ok)throw new Error(`Shopify quote failed (${res.status})`);
    const body:any=await res.json(),p=body.data?.product,v=p?.variants?.nodes?.[0];
    if(!p||!v)throw new Error("Product unavailable");
    return{title:p.title,sku:v.id,unitPriceMinor:Math.round(Number(v.price.amount)*100),currency:"INR",availableQuantity:v.quantityAvailable??undefined,checkoutMode:"API"};
  }
}

export class ControlledRetailerProvider implements RetailerProvider{
  constructor(private hostPattern:RegExp){}
  supports(url:string){try{return this.hostPattern.test(new URL(url).hostname)}catch{return false}}
  async quote():Promise<Quote>{throw new Error("Approved retailer pricing connection required")}
}
