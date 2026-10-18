import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock, createRoundMessage, getNightlySlot, getTimeZoneParts, getWindowDate, loadSlackEnvFile, main, nextSlotLabel, nightlyOffset, readSlotState } from "./a01-nightly-round.mjs";

const taipei = (iso) => getTimeZoneParts(new Date(iso), "Asia/Taipei");

test("accepts 23:50 and each 30-minute slot through 08:50", () => {
  assert.equal(getNightlySlot(taipei("2026-10-17T15:50:00.000Z")).offset, 0);
  assert.equal(getNightlySlot(taipei("2026-10-17T16:20:00.000Z")).offset, 30);
  assert.equal(getNightlySlot(taipei("2026-10-18T00:50:00.000Z")).offset, 540);
});

test("treats 09:00 as the exclusive end boundary", () => {
  const parts = taipei("2026-10-18T01:00:00.000Z");
  assert.equal(`${parts.hour}:${String(parts.minute).padStart(2, "0")}`, "9:00");
  assert.equal(nightlyOffset(parts), null);
  assert.equal(getNightlySlot(parts), null);
});

test("08:50 is the final send and displays 09:00, not 09:20", () => {
  const date = new Date("2026-10-18T00:50:00.000Z");
  const parts = getTimeZoneParts(date, "Asia/Taipei");
  assert.equal(getWindowDate(parts), "2026-10-17");
  assert.equal(nextSlotLabel(date, "Asia/Taipei", getNightlySlot(parts)), "09:00（窗口結束）");
});

test("does not accept off-cycle times inside the window", () => {
  assert.equal(getNightlySlot(taipei("2026-10-17T16:00:00.000Z")), null);
  assert.equal(getNightlySlot(taipei("2026-10-18T00:35:00.000Z")), null);
});

test("renders guardrails and the current git baseline", () => {
  const message = createRoundMessage({
    parts: taipei("2026-10-17T15:50:00.000Z"),
    next: "2026-10-18 00:20",
    mentions: "<@U123>",
    focus: "目前議題／main",
    git: { branch: "main", head: "abc1234", remoteMain: "def5678" },
  });

  assert.match(message, /<@U123>/);
  assert.match(message, /abc1234/);
  assert.match(message, /本機 HEAD：main @ abc1234；遠端 main：def5678/);
  assert.match(message, /不 merge、不 push/);
  assert.match(message, /migration 0003/);
});

test("reads only a specified owner-only Slack environment file", () => {
  const dir = mkdtempSync(join(tmpdir(), "a01-nightly-env-"));
  try {
    const file = join(dir, "slack.env");
    writeFileSync(file, "SLACK_BOT_TOKEN=fake-token\nA01_NIGHTLY_CHANNEL_ID=C_TEST\nA01_NIGHTLY_AGENT_MENTIONS=<@U123> <@U456>\n", { mode: 0o600 });
    assert.deepEqual(loadSlackEnvFile(file), {
      SLACK_BOT_TOKEN: "fake-token",
      A01_NIGHTLY_CHANNEL_ID: "C_TEST",
      A01_NIGHTLY_AGENT_MENTIONS: "<@U123> <@U456>",
    });
    writeFileSync(file, "DATABASE_URL=should-not-be-read\n", { mode: 0o600 });
    assert.throws(() => loadSlackEnvFile(file), /unsupported entry/);
    const publicFile = join(dir, "public.env");
    writeFileSync(publicFile, "SLACK_BOT_TOKEN=fake-token\n", { mode: 0o644 });
    assert.throws(() => loadSlackEnvFile(publicFile), /owner-only permissions/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reclaims an expired PID/timestamp lock and preserves an active lock", () => {
  const dir = mkdtempSync(join(tmpdir(), "a01-nightly-lock-"));
  const now = Date.parse("2026-10-18T00:00:00Z");
  try {
    const lock = join(dir, "run.lock");
    writeFileSync(lock, JSON.stringify({ pid: 123, startedAt: new Date(now - 11 * 60_000).toISOString(), token: "old" }));
    const release = acquireLock(lock, now);
    assert.equal(typeof release, "function");
    const record = JSON.parse(readFileSync(lock, "utf8"));
    assert.equal(record.pid, process.pid);
    assert.equal(record.startedAt, new Date(now).toISOString());
    assert.equal(acquireLock(lock, now), null);
    release();
    assert.equal(acquireLock(lock, now) instanceof Function, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("records a slot before posting and never sends the same slot twice", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a01-nightly-slot-"));
  try {
    const file = join(dir, "slack.env");
    writeFileSync(file, "SLACK_BOT_TOKEN=fake-token\nA01_NIGHTLY_CHANNEL_ID=C_TEST\nA01_NIGHTLY_AGENT_MENTIONS=<@U123> <@U456>\n", { mode: 0o600 });
    const sent = [];
    const output = [];
    const args = ["--execute", "--window-date", "2026-10-17", "--env-file", file];
    const env = {
      A01_NIGHTLY_STATE_DIR: dir,
      A01_NIGHTLY_REPO: dir,
      SLACK_BOT_TOKEN: "unrelated-token",
      A01_NIGHTLY_CHANNEL_ID: "C_WRONG",
    };
    const fetchImpl = async (_url, request) => {
      sent.push(JSON.parse(request.body));
      return { ok: true, status: 200, json: async () => ({ ok: true, ts: "123.456" }) };
    };
    const nowDate = new Date("2026-10-17T15:50:00Z");
    await main({ argv: args, env, fetchImpl, nowDate, output: (line) => output.push(line) });
    await main({ argv: args, env, fetchImpl, nowDate, output: (line) => output.push(line) });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].channel, "C_TEST");
    assert.match(sent[0].text, /<@U123> <@U456>/);
    assert.equal(readSlotState(join(dir, "slots.json")).slots["2026-10-17T23:50"].status, "sent");
    assert.match(output.join("\n"), /already attempted/);
    assert.doesNotMatch(output.join("\n"), /fake-token/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("keeps a failed or uncertain post claimed so a retry cannot duplicate it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a01-nightly-fail-"));
  try {
    const file = join(dir, "slack.env");
    writeFileSync(file, "SLACK_BOT_TOKEN=fake-token\nA01_NIGHTLY_CHANNEL_ID=C_TEST\nA01_NIGHTLY_AGENT_MENTIONS=<@U123>\n", { mode: 0o600 });
    const args = ["--execute", "--window-date", "2026-10-17", "--env-file", file];
    const env = { A01_NIGHTLY_STATE_DIR: dir, A01_NIGHTLY_REPO: dir };
    let calls = 0;
    const fetchImpl = async () => { calls += 1; throw new Error("uncertain transport"); };
    const nowDate = new Date("2026-10-17T15:50:00Z");
    await assert.rejects(main({ argv: args, env, fetchImpl, nowDate, output: () => {} }), /uncertain transport/);
    await main({ argv: args, env, fetchImpl, nowDate, output: () => {} });
    assert.equal(calls, 1);
    assert.equal(readSlotState(join(dir, "slots.json")).slots["2026-10-17T23:50"].status, "failed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a configured window sends once that night and skips the next night", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a01-nightly-window-"));
  try {
    const file = join(dir, "slack.env");
    writeFileSync(file, "SLACK_BOT_TOKEN=fake-token\nA01_NIGHTLY_CHANNEL_ID=C_TEST\nA01_NIGHTLY_AGENT_MENTIONS=<@U123>\n", { mode: 0o600 });
    const argv = ["--execute", "--window-date", "2026-10-17", "--env-file", file];
    const env = { A01_NIGHTLY_STATE_DIR: dir, A01_NIGHTLY_REPO: dir };
    let calls = 0;
    const output = [];
    const fetchImpl = async () => {
      calls += 1;
      return { ok: true, status: 200, json: async () => ({ ok: true, ts: "123.456" }) };
    };
    await main({ argv, env, fetchImpl, nowDate: new Date("2026-10-17T15:50:00Z"), output: (line) => output.push(line) });
    await main({ argv, env, fetchImpl, nowDate: new Date("2026-10-18T15:50:00Z"), output: (line) => output.push(line) });
    assert.equal(calls, 1);
    assert.match(output.join("\n"), /outside the configured one-time window/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a network timeout leaves a terminal failed slot instead of retrying", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a01-nightly-timeout-"));
  try {
    const file = join(dir, "slack.env");
    writeFileSync(file, "SLACK_BOT_TOKEN=fake-token\nA01_NIGHTLY_CHANNEL_ID=C_TEST\nA01_NIGHTLY_AGENT_MENTIONS=<@U123>\n", { mode: 0o600 });
    const argv = ["--execute", "--window-date", "2026-10-17", "--env-file", file];
    const env = { A01_NIGHTLY_STATE_DIR: dir, A01_NIGHTLY_REPO: dir };
    let calls = 0;
    const fetchImpl = async (_url, request) => {
      calls += 1;
      return new Promise((_resolve, reject) => {
        const watchdog = setTimeout(() => reject(new Error("timeout signal was not raised")), 100);
        request.signal.addEventListener("abort", () => {
          clearTimeout(watchdog);
          reject(request.signal.reason);
        }, { once: true });
      });
    };
    const options = { argv, env, fetchImpl, nowDate: new Date("2026-10-17T15:50:00Z"), slackTimeoutMs: 5, output: () => {} };
    await assert.rejects(main(options), /timeout/i);
    await main(options);
    assert.equal(calls, 1);
    assert.equal(readSlotState(join(dir, "slots.json")).slots["2026-10-17T23:50"].status, "failed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("execute requires explicit Agent mentions and forbids a simulated clock", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a01-nightly-mentions-"));
  try {
    const file = join(dir, "slack.env");
    writeFileSync(file, "SLACK_BOT_TOKEN=fake-token\nA01_NIGHTLY_CHANNEL_ID=C_TEST\n", { mode: 0o600 });
    const env = { A01_NIGHTLY_STATE_DIR: dir, A01_NIGHTLY_REPO: dir };
    await assert.rejects(main({
      argv: ["--execute", "--window-date", "2026-10-17", "--env-file", file],
      env,
      nowDate: new Date("2026-10-17T15:50:00Z"),
      fetchImpl: () => { throw new Error("must not fetch"); },
      output: () => {},
    }), /A01_NIGHTLY_AGENT_MENTIONS/);
    await assert.rejects(main({
      argv: ["--execute", "--window-date", "2026-10-17", "--now", "2026-10-17T15:50:00Z"],
      env,
      output: () => {},
    }), /dry-run only/);
    await assert.rejects(main({
      argv: ["--execute", "--window-date", "2026-10-17"],
      env: { ...env, A01_NIGHTLY_TIMEZONE: "UTC" },
      output: () => {},
    }), /Asia\/Taipei/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dry-run never reads a Slack file or creates send state", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a01-nightly-dry-"));
  try {
    const output = [];
    await main({
      argv: ["--now", "2026-10-17T15:50:00Z", "--env-file", join(dir, "missing.env")],
      env: { A01_NIGHTLY_STATE_DIR: dir, A01_NIGHTLY_REPO: dir },
      fetchImpl: () => { throw new Error("must not fetch"); },
      output: (line) => output.push(line),
    });
    assert.match(output.join("\n"), /DRY_RUN/);
    assert.throws(() => readFileSync(join(dir, "slots.json")), /ENOENT/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("execute does not auto-load the repo .env", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a01-nightly-repo-env-"));
  try {
    writeFileSync(join(dir, ".env"), "SLACK_BOT_TOKEN=must-not-load\nA01_NIGHTLY_CHANNEL_ID=C_WRONG\n");
    await assert.rejects(main({
      argv: ["--execute", "--window-date", "2026-10-17"],
      env: { A01_NIGHTLY_REPO: dir, A01_NIGHTLY_STATE_DIR: dir, A01_NIGHTLY_AGENT_MENTIONS: "<@U123>" },
      nowDate: new Date("2026-10-17T15:50:00Z"),
      fetchImpl: () => { throw new Error("must not fetch"); },
      output: () => {},
    }), /SLACK_BOT_TOKEN is required/);
    assert.throws(() => readFileSync(join(dir, "slots.json")), /ENOENT/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
