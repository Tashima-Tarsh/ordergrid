const API_ORIGIN="https://hylywqeeudxvjrykdfop.supabase.co/functions/v1/ordergrid-api";

async function proxyApi(request){
  const incoming=new URL(request.url);
  const headers=new Headers(request.headers);
  headers.delete("host");
  headers.delete("content-length");
  headers.set("x-ordergrid-path",incoming.pathname+incoming.search);
  headers.set("x-forwarded-host",incoming.host);
  headers.set("x-forwarded-proto",incoming.protocol.replace(":",""));

  const init={method:request.method,headers,redirect:"manual"};
  if(request.method!=="GET"&&request.method!=="HEAD")init.body=request.body;

  const upstream=await fetch(API_ORIGIN,init);
  const responseHeaders=new Headers(upstream.headers);
  responseHeaders.set("cache-control","no-store, private");

  return new Response(upstream.body,{
    status:upstream.status,
    statusText:upstream.statusText,
    headers:responseHeaders
  });
}

export default {
  async fetch(request,env){
    const url=new URL(request.url);
    if(url.pathname==="/api"||url.pathname.startsWith("/api/")){
      try{return await proxyApi(request)}
      catch(error){
        console.error("OrderGrid Supabase API proxy failed",error);
        return Response.json(
          {error:"api_unavailable",message:"OrderGrid production API is temporarily unavailable."},
          {status:502,headers:{"cache-control":"no-store"}}
        );
      }
    }
    return env.ASSETS.fetch(request);
  }
};
