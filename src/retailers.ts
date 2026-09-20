import { isIP } from "node:net";

const SUPPORTED = [
  { id: "amazon-in", name: "Amazon India", hosts: ["amazon.in"] },
  { id: "flipkart", name: "Flipkart", hosts: ["flipkart.com"] },
  { id: "myntra", name: "Myntra", hosts: ["myntra.com"] },
  { id: "ajio", name: "AJIO", hosts: ["ajio.com"] },
  { id: "tatacliq", name: "Tata CLiQ", hosts: ["tatacliq.com"] },
  { id: "meesho", name: "Meesho", hosts: ["meesho.com"] },
  { id: "nykaa", name: "Nykaa", hosts: ["nykaa.com"] },
  { id: "jiomart", name: "JioMart", hosts: ["jiomart.com"] }
] as const;

const hostMatches=(host:string,root:string)=>host===root||host.endsWith(`.${root}`);

export type RetailerIdentity={id:string;name:string;host:string;mode:"ORDERGRID_WORKER"|"API"};

function publicStoreHost(host:string){
  if(!host||host==="localhost"||host.endsWith(".localhost")||host.endsWith(".local"))return false;
  if(isIP(host))return false;
  return host.includes(".");
}

export function retailerForProductUrl(value:string):RetailerIdentity {
  if(value.length>2048)throw new Error("Product URL is too long");
  const url=new URL(value);
  if(url.protocol!=="https:")throw new Error("Only HTTPS product URLs are supported");
  if(url.username||url.password)throw new Error("Product URLs cannot contain credentials");
  const host=url.hostname.toLowerCase().replace(/.$/,"");
  const known=SUPPORTED.find(r=>r.hosts.some(root=>hostMatches(host,root)));
  if(known)return{id:known.id,name:known.name,host,mode:"ORDERGRID_WORKER"};
  if(!publicStoreHost(host))throw new Error("Unsupported retailer product URL");
  return{id:`store:${host}`,name:host.replace(/^www\./,""),host,mode:"ORDERGRID_WORKER"};
}

export function verifiedRetailerUrl(value:string){
  retailerForProductUrl(value);
  const url=new URL(value);
  url.hash="";
  return url.toString();
}

export function validateRetailerOrderId(value:string){
  const orderId=value.trim();
  if(!/^[A-Za-z0-9][A-Za-z0-9._\/-]{2,79}$/.test(orderId))throw new Error("Invalid retailer order ID");
  return orderId;
}
