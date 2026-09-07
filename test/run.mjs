import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const core = require("../js/core.js");
const root = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(root, "..");

let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log("ok ", name);
  } catch (err) {
    failed += 1;
    console.error("FAIL", name);
    console.error("   ", err && err.message ? err.message : err);
  }
}

test("normalizeInstance adds https and strips slash", () => {
  assert.equal(core.normalizeInstance("fediverse.example"), "https://fediverse.example");
  assert.equal(core.normalizeInstance("https://x.test/"), "https://x.test");
  assert.equal(core.normalizeInstance(""), "");
  assert.equal(core.normalizeInstance("not a host"), "");
});

test("instanceHost", () => {
  assert.equal(core.instanceHost("https://a.example:443"), "a.example");
});

test("pollIntervalMs clamps", () => {
  assert.equal(core.pollIntervalMs({ poll_minutes: 2 }), 120000);
  assert.equal(core.pollIntervalMs({ poll: 0 }), 120000);
  assert.equal(core.pollIntervalMs({ poll_minutes: 0.1 }), 15000);
  assert.equal(core.pollIntervalMs({ poll_minutes: 99999 }), 1440 * 60 * 1000);
});

test("maxCharsFromInstance", () => {
  assert.equal(core.maxCharsFromInstance({ max_toot_chars: 5000 }), 5000);
  assert.equal(core.maxCharsFromInstance({ configuration: { statuses: { max_characters: 7000 } } }), 7000);
  assert.equal(core.maxCharsFromInstance({}), 0);
});

test("idNewer snowflake", () => {
  assert.equal(core.idNewer("2", "1"), true);
  assert.equal(core.idNewer("1", "2"), false);
  assert.equal(core.idNewer("10", "9"), true);
  assert.equal(core.idNewer("100", "99"), true);
  assert.equal(core.idNewer("9", "10"), false);
  assert.equal(core.idNewer("5", "5"), false);
  assert.equal(core.idNewer("5", ""), false);
});

test("isMissingStatus", () => {
  assert.equal(core.isMissingStatus({ status: 404, message: "x" }), true);
  assert.equal(core.isMissingStatus({ status: 410, message: "x" }), true);
  assert.equal(core.isMissingStatus({ message: "Record not found" }), true);
  assert.equal(core.isMissingStatus({ status: 401, message: "unauthorized" }), false);
  assert.equal(core.isMissingStatus({ network: true, message: "Failed to fetch" }), false);
});

test("isNetworkError", () => {
  assert.equal(core.isNetworkError({ network: true }), true);
  assert.equal(core.isNetworkError({ message: "Failed to fetch" }), true);
  assert.equal(core.isNetworkError({ message: "Record not found" }), false);
});

test("tagNameFromHref", () => {
  assert.equal(core.tagNameFromHref("https://ex.test/tags/neon"), "neon");
  assert.equal(core.tagNameFromHref("https://ex.test/tag/Retro"), "Retro");
  assert.equal(core.tagNameFromHref("https://ex.test/@user"), "");
});

test("mentionAcctFromHref", () => {
  assert.equal(core.mentionAcctFromHref("https://ex.test/@alice", "https://app.test/", "ex.test"), "alice");
  assert.equal(
    core.mentionAcctFromHref("https://other.test/@bob", "https://app.test/", "ex.test"),
    "bob@other.test"
  );
  assert.equal(core.mentionAcctFromHref("https://ex.test/users/carol", "https://app.test/", "ex.test"), "carol");
});

test("appBaseUrl strips index.html", () => {
  assert.equal(core.appBaseUrl({ origin: "https://nb.test", pathname: "/app/index.html" }), "https://nb.test/app/");
  assert.equal(core.appBaseUrl({ origin: "https://nb.test", pathname: "/" }), "https://nb.test/");
});

test("flushPlan create", () => {
  assert.deepEqual(core.flushPlan({ action: "create", payload: { status: "hi" } }, true), { method: "POST" });
});

test("flushPlan edit exists", () => {
  assert.deepEqual(core.flushPlan({ action: "edit", statusId: "9", payload: { status: "x" } }, true), {
    method: "PUT",
    statusId: "9",
  });
});

test("flushPlan edit missing", () => {
  const plan = core.flushPlan({ action: "edit", statusId: "9", payload: {} }, false);
  assert.equal(plan.error.includes("nicht mehr"), true);
});

test("flushPlan delete missing is done", () => {
  assert.deepEqual(core.flushPlan({ action: "delete", statusId: "9", payload: {} }, false), { done: true });
});

test("flushPlan delete exists", () => {
  assert.deepEqual(core.flushPlan({ action: "delete", statusId: "9", payload: {} }, true), {
    method: "DELETE",
    statusId: "9",
  });
});

const html = path.join(root, "sanitize.html");
const chrome = spawnSync("chromium", ["--headless=new", "--disable-gpu", "--no-sandbox", "--virtual-time-budget=4000", "--dump-dom", pathToFileURL(html).href], {
  encoding: "utf8",
  timeout: 15000,
});
if (chrome.error) {
  console.log("skip sanitize (no chromium):", chrome.error.message);
} else {
  const out = (chrome.stdout || "") + (chrome.stderr || "");
  test("sanitize in chromium", () => {
    assert.match(out, /<title>PASS<\/title>|id="out">PASS/);
  });
}

if (failed) {
  console.error(failed + " failed");
  process.exit(1);
}
console.log("all tests passed");
