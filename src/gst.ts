export type GstLineInput={
  description:string;
  hsnSac:string;
  quantity:number;
  amountMinor:number;
  gstRate:number;
  cessRate?:number;
  priceIncludesGst:boolean;
};

export type GstLineResult=GstLineInput&{
  taxableMinor:number;
  cgstMinor:number;
  sgstMinor:number;
  igstMinor:number;
  cessMinor:number;
  totalMinor:number;
};

const round=(n:number)=>Math.round(n);

export function financialYearForDate(value:Date){
  const year=value.getUTCFullYear(),month=value.getUTCMonth()+1;
  const start=month>=4?year:year-1;
  return `${start}-${String((start+1)%100).padStart(2,"0")}`;
}

export function calculateGstLine(input:GstLineInput,supplierStateCode:string,buyerStateCode:string):GstLineResult{
  if(!/^\d{2}$/.test(supplierStateCode)||!/^\d{2}$/.test(buyerStateCode))throw new Error("invalid_state_code");
  if(!input.hsnSac.trim())throw new Error("hsn_sac_required");
  if(input.quantity<=0||input.amountMinor<0)throw new Error("invalid_line_amount");
  if(input.gstRate<0||input.gstRate>100)throw new Error("invalid_gst_rate");
  const cessRate=input.cessRate??0;
  if(cessRate<0||cessRate>100)throw new Error("invalid_cess_rate");
  const rate=input.gstRate+cessRate;
  const taxableMinor=input.priceIncludesGst?round(input.amountMinor/(1+rate/100)):input.amountMinor;
  const gstMinor=round(taxableMinor*input.gstRate/100);
  const cessMinor=round(taxableMinor*cessRate/100);
  const intra=supplierStateCode===buyerStateCode;
  const cgstMinor=intra?round(gstMinor/2):0;
  const sgstMinor=intra?gstMinor-cgstMinor:0;
  const igstMinor=intra?0:gstMinor;
  const totalMinor=input.priceIncludesGst?input.amountMinor:taxableMinor+gstMinor+cessMinor;
  return {...input,cessRate,taxableMinor,cgstMinor,sgstMinor,igstMinor,cessMinor,totalMinor};
}

export function calculateGstInvoice(lines:GstLineInput[],supplierStateCode:string,buyerStateCode:string){
  if(!lines.length)throw new Error("invoice_lines_required");
  const calculated=lines.map(line=>calculateGstLine(line,supplierStateCode,buyerStateCode));
  return {
    lines:calculated,
    taxableMinor:calculated.reduce((n,x)=>n+x.taxableMinor,0),
    cgstMinor:calculated.reduce((n,x)=>n+x.cgstMinor,0),
    sgstMinor:calculated.reduce((n,x)=>n+x.sgstMinor,0),
    igstMinor:calculated.reduce((n,x)=>n+x.igstMinor,0),
    cessMinor:calculated.reduce((n,x)=>n+x.cessMinor,0),
    totalMinor:calculated.reduce((n,x)=>n+x.totalMinor,0)
  };
}

const STATE_CODES:Record<string,string>={
  "jammu and kashmir":"01","himachal pradesh":"02","punjab":"03","chandigarh":"04","uttarakhand":"05","haryana":"06","delhi":"07",
  "rajasthan":"08","uttar pradesh":"09","bihar":"10","sikkim":"11","arunachal pradesh":"12","nagaland":"13","manipur":"14","mizoram":"15",
  "tripura":"16","meghalaya":"17","assam":"18","west bengal":"19","jharkhand":"20","odisha":"21","chhattisgarh":"22","madhya pradesh":"23",
  "gujarat":"24","dadra and nagar haveli and daman and diu":"26","maharashtra":"27","andhra pradesh":"37","karnataka":"29","goa":"30",
  "lakshadweep":"31","kerala":"32","tamil nadu":"33","puducherry":"34","andaman and nicobar islands":"35","telangana":"36","ladakh":"38"
};

export function stateCodeForName(name:string){
  return STATE_CODES[String(name||"").trim().toLowerCase()]??null;
}

export function validateGstin(value:string){
  return /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(String(value||"").trim().toUpperCase());
}
