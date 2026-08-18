/**
 * Minimal Sites adapter for the existing AI-adm-D1 Vite SPA.
 * The UI remains the Vite build; this worker only serves assets and keeps
 * client-side deep routes on the existing index.html entry point.
 */
const worker = {
  async fetch(request, env) {
    const response = await env.ASSETS.fetch(request);
    if (response.status !== 404 || request.method !== "GET") return response;

    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return response;
    return env.ASSETS.fetch(new Request(new URL("/index.html", request.url), request));
  },
};

export default worker;
