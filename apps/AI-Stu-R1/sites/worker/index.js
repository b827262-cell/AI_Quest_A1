/**
 * Minimal Sites adapter for the existing AI-Stu-R1 Vite SPA.
 * The UI remains the Vite build; this worker only serves assets and keeps
 * client-side deep routes on the existing index.html entry point.
 */
const worker = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const isSpaRoute = request.method === "GET"
      && !url.pathname.startsWith("/api/")
      && !url.pathname.startsWith("/assets/")
      && !/\.[^/]+$/.test(url.pathname);

    if (isSpaRoute && url.pathname !== "/") {
      return env.ASSETS.fetch(new Request(new URL("/", request.url), request));
    }

    const response = await env.ASSETS.fetch(request);
    if (response.status !== 404 || request.method !== "GET") return response;

    if (url.pathname.startsWith("/api/")) return response;
    return env.ASSETS.fetch(new Request(new URL("/", request.url), request));
  },
};

export default worker;
