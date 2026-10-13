import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const siteDir = path.resolve(__dirname, "..");
const clientDir = path.resolve(siteDir, "dist/client");
const workerUrl = new URL("../dist/server/index.js", import.meta.url);

const { default: worker } = await import(workerUrl.href);

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
  ".onnx": "application/octet-stream",
};

const dummyR2 = {
  get: async () => null,
  put: async () => null,
  delete: async () => null,
  list: async () => ({ objects: [], truncated: false }),
};

const dummyD1 = {
  prepare: () => ({
    bind: () => ({
      all: async () => ({ results: [] }),
      first: async () => null,
      run: async () => ({ success: true }),
    }),
    all: async () => ({ results: [] }),
    first: async () => null,
    run: async () => ({ success: true }),
  }),
};

const workerEnv = {
  BOOKS_BUCKET: dummyR2,
  DB: dummyD1,
  ASSETS: {
    fetch: async (req) => {
      const url = new URL(req.url);
      const filePath = path.join(clientDir, url.pathname);
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const ext = path.extname(filePath);
        return new Response(fs.readFileSync(filePath), {
          headers: { "content-type": MIME_TYPES[ext] || "application/octet-stream" },
        });
      }
      return new Response("Not found", { status: 404 });
    },
  },
};

const PORT = 3002;
const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
  let filePath = path.join(clientDir, urlObj.pathname);

  // If static file exists directly in dist/client, serve it
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath);
    res.setHeader("Content-Type", MIME_TYPES[ext] || "application/octet-stream");
    return fs.createReadStream(filePath).pipe(res);
  }

  // Otherwise delegate to Cloudflare Worker
  try {
    const fullUrl = `http://127.0.0.1:${PORT}${req.url}`;
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (v) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
    }

    let body = null;
    if (req.method !== "GET" && req.method !== "HEAD") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      body = Buffer.concat(chunks);
    }

    const workerReq = new Request(fullUrl, {
      method: req.method,
      headers,
      body,
    });

    const workerRes = await worker.fetch(workerReq, workerEnv, {
      waitUntil() {},
      passThroughOnException() {},
    });

    res.statusCode = workerRes.status;
    workerRes.headers.forEach((val, key) => {
      res.setHeader(key, val);
    });

    const resBody = await workerRes.arrayBuffer();
    res.end(Buffer.from(resBody));
  } catch (err) {
    console.error("Worker fetch error:", err);
    res.statusCode = 500;
    res.end("Internal QA Server Error: " + err.message);
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[QA SERVER] AI-Quest-A1 QA server running at http://127.0.0.1:${PORT}`);
});
