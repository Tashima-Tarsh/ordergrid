const DEFAULT_API_ORIGIN="https://ordergrid-production.onrender.com";

function upstreamUrl(request,env){
  const incoming=new URL(request.url);
  const base=new URL(env.ORDERGRID_API_ORIGIN||DEFAULT_API_ORIGIN);
  base.pathname=incoming.pathname;
  base.search=incoming.search;
  return base;
}

async function proxyApi(request,env){
  const target=upstreamUrl(request,env);
  const headers=new Headers(request.headers);
  headers.set("x-forwarded-host",new URL(request.url).host);
  headers.set("x-forwarded-proto","https");
  headers.delete("host");

  const init={
    method:request.method,
    headers,
    redirect:"manual"
  };
  if(request.method!=="GET"&&request.method!=="HEAD")init.body=request.body;

  const upstream=await fetch(target.toString(),init);
  const responseHeaders=new Headers(upstream.headers);
  responseHeaders.set("cache-control","no-store, private");

  const location=responseHeaders.get("location");
  if(location){
    try{
      const resolved=new URL(location,target);
      const apiOrigin=new URL(env.ORDERGRID_API_ORIGIN||DEFAULT_API_ORIGIN);
      if(resolved.origin===apiOrigin.origin){
        const publicUrl=new URL(request.url);
        resolved.protocol=publicUrl.protocol;
        resolved.host=publicUrl.host;
        responseHeaders.set("location",resolved.toString());
      }
    }catch{}
  }

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
      try{return await proxyApi(request,env)}
      catch(error){
        console.error("OrderGrid API proxy failed",error);
        return Response.json(
          {error:"api_unavailable",message:"OrderGrid backend is temporarily unavailable."},
          {status:502,headers:{"cache-control":"no-store"}}
        );
      }
    }
    return env.ASSETS.fetch(request);
  }
};
