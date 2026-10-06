// Deliberately local-only: receive installed-app share POST bodies without
// putting answer text in the URL, history, or a remote request.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

const SHARE_DB = "ai-smartbook-share-intake-v1";
const SHARE_STORE = "pending";

function shareDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(SHARE_DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(SHARE_STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function storeShareIntake(formData) {
  const text = formData.get("text");
  const title = formData.get("title");
  const url = formData.get("url");
  const payload = {
    // URL-only shares are deliberately not an answer. Keep it only as context.
    text: typeof text === "string" ? text : "",
    title: typeof title === "string" ? title : "",
    url: typeof url === "string" ? url : ""
  };
  const db = await shareDatabase();
  await new Promise((resolve, reject) => {
    const transaction = db.transaction(SHARE_STORE, "readwrite");
    transaction.objectStore(SHARE_STORE).put(payload, "latest");
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
}

async function consumeShareIntake() {
  const db = await shareDatabase();
  const payload = await new Promise((resolve, reject) => {
    const transaction = db.transaction(SHARE_STORE, "readwrite");
    const store = transaction.objectStore(SHARE_STORE);
    const request = store.get("latest");
    request.onsuccess = () => { if (request.result) store.delete("latest"); };
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => resolve(request.result ?? null);
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
  return payload;
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method === "POST" && url.origin === self.location.origin && url.pathname === "/share-target") {
    event.respondWith((async () => {
      await storeShareIntake(await request.formData());
      // Returning the shell directly keeps raw text out of URLs and access logs.
      return fetch(new Request("/", { headers: { Accept: "text/html" } }));
    })());
  }
});

self.addEventListener("message", (event) => {
  if (event.data?.type !== "consume-share-intake") return;
  event.waitUntil(consumeShareIntake().then((payload) => {
    event.source?.postMessage({ type: "share-intake", payload });
  }).catch(() => event.source?.postMessage({ type: "share-intake", payload: null })));
});
