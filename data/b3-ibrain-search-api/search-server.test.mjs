import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { startSearchServer, validateSearchHost } from "./search-server.mjs";

test("host policy permits only named loopback addresses by default", () => {
  for (const host of ["127.0.0.1", "::1", "localhost", "LOCALHOST"]) {
    assert.doesNotThrow(() => validateSearchHost(host, "0"));
  }
  for (const host of ["0.0.0.0", "::", "192.0.2.1", "example.com", "", " localhost "]) {
    for (const optIn of [undefined, "0", "true", true, 1]) {
      assert.throws(() => validateSearchHost(host, optIn ?? ""), /B3_SEARCH_ALLOW_NON_LOOPBACK=1/);
    }
    assert.doesNotThrow(() => validateSearchHost(host, "1"));
  }
});

test("startSearchServer rejects a public host before constructing a store or listener", () => {
  assert.throws(() => startSearchServer({ host: "0.0.0.0", allowNonLoopback: "0", connectionString: "" }), /non-loopback/);
});

test("startSearchServer starts an ephemeral loopback listener", async () => {
  const server = startSearchServer({ host: "127.0.0.1", port: 0, store: { kind: "test" }, allowNonLoopback: "0" });
  await once(server, "listening");
  try {
    assert.equal(server.address().address, "127.0.0.1");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("CLI rejects non-loopback environment configuration with exit 1", () => {
  const result = spawnSync(process.execPath, ["data/b3-ibrain-search-api/search-server.mjs"], {
    env: { B3_SEARCH_STORE: "snapshot", B3_SEARCH_HOST: "0.0.0.0", B3_SEARCH_ALLOW_NON_LOOPBACK: "0" },
    encoding: "utf8", timeout: 5000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /non-loopback.*B3_SEARCH_HOST/);
});
