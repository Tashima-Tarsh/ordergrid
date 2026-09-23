async function proxyApi(request, env) {
  const incoming = new URL(request.url);
  const apiOrigin = (env.API_ORIGIN || env.ORDERGRID_API_ORIGIN || "http://127.0.0.1:3000").replace(/\/$/, "");
  const targetUrl = new URL(incoming.pathname + incoming.search, apiOrigin);

  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("content-length");
  headers.set("x-forwarded-host", incoming.host);
  headers.set("x-forwarded-proto", incoming.protocol.replace(":", ""));
  headers.set("x-ordergrid-proxy", "cloudflare");

  const init = {
    method: request.method,
    headers,
    redirect: "manual"
  };

  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
  }

  const upstream = await fetch(targetUrl.toString(), init);
  const responseHeaders = new Headers(upstream.headers);
  responseHeaders.set("cache-control", "no-store, private");

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      try {
        return await proxyApi(request, env);
      } catch (error) {
        console.error("OrderGrid AWS API proxy failed", error);
        return Response.json(
          { error: "api_unavailable", message: "OrderGrid production API is temporarily unavailable." },
          { status: 502, headers: { "cache-control": "no-store" } }
        );
      }
    }
    return env.ASSETS.fetch(request);
  }
};
