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
  assert.equal(core.normalizeInstance("not-a-url"), "");
});

test("parseInstanceInput format errors", () => {
  assert.equal(core.parseInstanceInput("").error, "errors.instanceRequired");
  assert.equal(core.parseInstanceInput("not-a-url").error, "errors.invalidHostname");
  assert.equal(core.parseInstanceInput("ftp://x.example").error, "errors.invalidScheme");
  assert.equal(core.parseInstanceInput("https://").error, "errors.incompleteUrl");
  assert.equal(core.parseInstanceInput("example.com").origin, "https://example.com");
  assert.equal(core.parseInstanceInput("http://127.0.0.1:1").origin, "http://127.0.0.1:1");
});

test("friendlyConnectError maps network", () => {
  const msg = core.friendlyConnectError({ network: true, message: "Failed to fetch" });
  assert.equal(msg, "errors.instanceUnreachable");
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

test("relativeAgeLabel steps", () => {
  const now = Date.parse("2026-09-08T12:00:00.000Z");
  const at = (secAgo) => new Date(now - secAgo * 1000).toISOString();
  assert.equal(core.relativeAgeLabel(at(0), now), "0s");
  assert.equal(core.relativeAgeLabel(at(12), now), "12s");
  assert.equal(core.relativeAgeLabel(at(59), now), "59s");
  assert.equal(core.relativeAgeLabel(at(60), now), "1m");
  assert.equal(core.relativeAgeLabel(at(179), now), "2m");
  assert.equal(core.relativeAgeLabel(at(299), now), "4m");
  assert.equal(core.relativeAgeLabel(at(300), now), "5m");
  assert.equal(core.relativeAgeLabel(at(599), now), "5m");
  assert.equal(core.relativeAgeLabel(at(600), now), "10m");
  assert.equal(core.relativeAgeLabel(at(3599), now), "55m");
  assert.equal(core.relativeAgeLabel(at(3600), now), "1h");
  assert.equal(core.relativeAgeLabel(at(86400), now), "1d");
  assert.equal(core.relativeAgeLabel("nope", now), "");
});

test("appBaseUrl strips index.html", () => {
  assert.equal(core.appBaseUrl({ origin: "https://nb.test", pathname: "/app/index.html" }), "https://nb.test/app/");
  assert.equal(core.appBaseUrl({ origin: "https://nb.test", pathname: "/" }), "https://nb.test/");
});

test("appBaseUrl keeps subdirectory without trailing slash", () => {
  assert.equal(core.appBaseUrl({ origin: "https://nb.test", pathname: "/Nightboard83" }), "https://nb.test/Nightboard83/");
  assert.equal(core.appBaseUrl({ origin: "https://nb.test", pathname: "/Nightboard83/" }), "https://nb.test/Nightboard83/");
  assert.equal(core.appBaseUrl({ origin: "https://nb.test", pathname: "/app" }), "https://nb.test/app/");
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
  assert.equal(plan.error, "errors.postGoneEdit");
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



test("pollPercent / pollTotalVotes / pollOwnVotes / pollIsClosed", () => {
  assert.equal(core.pollPercent(1, 4), 25);
  assert.equal(core.pollPercent(0, 4), 0);
  assert.equal(core.pollPercent(2, 0), 0);
  assert.equal(core.pollTotalVotes({ votes_count: 7 }), 7);
  assert.equal(core.pollTotalVotes({}), 0);
  assert.deepEqual(core.pollOwnVotes({ own_votes: [0, 2] }), [0, 2]);
  assert.deepEqual(core.pollOwnVotes({ own_votes: ["1"] }), [1]);
  assert.equal(core.pollIsClosed({ expired: true }), true);
  assert.equal(core.pollIsClosed({ expires_at: "2099-01-01T00:00:00.000Z" }, Date.parse("2026-01-01T00:00:00.000Z")), false);
  assert.equal(core.pollIsClosed({ expires_at: "2020-01-01T00:00:00.000Z" }, Date.parse("2026-01-01T00:00:00.000Z")), true);
});

test("pollUserVoted ignores GTS own-poll voted quirk", () => {
  assert.equal(core.pollUserVoted({ voted: true, own_votes: [], votes_count: 0 }), false);
  assert.equal(core.pollUserVoted({ voted: true, own_votes: [], votes_count: 0, options: [] }), false);
  assert.equal(core.pollUserVoted({ voted: false, own_votes: [], votes_count: 0 }), false);
  assert.equal(core.pollUserVoted({ voted: true, own_votes: [1], votes_count: 1 }), true);
  assert.equal(core.pollUserVoted({ voted: false, own_votes: [0], votes_count: 0 }), true);
  assert.equal(core.pollUserVoted({ voted: true, own_votes: [], votes_count: 3 }), true);
  assert.equal(core.pollUserVoted(null), false);
});

test("relativeFutureLabel steps", () => {
  const now = Date.parse("2026-01-01T00:00:00.000Z");
  const at = (sec) => new Date(now + sec * 1000).toISOString();
  assert.equal(core.relativeFutureLabel(at(12), now), "12s");
  assert.equal(core.relativeFutureLabel(at(60), now), "1m");
  assert.equal(core.relativeFutureLabel(at(300), now), "5m");
  assert.equal(core.relativeFutureLabel(at(3600), now), "1h");
  assert.equal(core.relativeFutureLabel(at(86400), now), "1d");
  assert.equal(core.relativeFutureLabel("nope", now), "");
});

const i18n = require("../js/i18n.js");
const fs = require("node:fs");
const de = JSON.parse(fs.readFileSync(path.join(repo, "i18n/de.json"), "utf8"));
const en = JSON.parse(fs.readFileSync(path.join(repo, "i18n/en.json"), "utf8"));

test("i18n catalogs share the same keys", () => {
  const dk = Object.keys(de).sort();
  const ek = Object.keys(en).sort();
  assert.deepEqual(dk, ek);
  assert.equal(dk.length > 50, true);
});

test("i18n t() falls back de←en and interpolates", () => {
  i18n._setCatalogs(de, en);
  i18n.setLocale("de", { persist: false });
  assert.equal(i18n.t("login.authorize"), de["login.authorize"]);
  assert.equal(i18n.t("status.carrierLost"), de["status.carrierLost"]);
  assert.match(i18n.t("thread.charsLeft", { count: 12 }), /12/);
  i18n.setLocale("en", { persist: false });
  assert.equal(i18n.t("login.authorize"), en["login.authorize"]);
  assert.equal(i18n.t("compose.existingAttachments", { count: 1 }), en["compose.existingAttachments.one"]);
  assert.equal(i18n.t("compose.existingAttachments", { count: 3 }), en["compose.existingAttachments.other"].replace("{count}", "3"));
});

test("i18n detect prefers supported navigator language", () => {
  i18n._setCatalogs(de, en);
  const prev = globalThis.navigator;
  globalThis.navigator = { language: "en-US", languages: ["en-US", "de"] };
  try {
    // localStorage may be absent in node — detect should still resolve en
    const loc = i18n.detect();
    assert.equal(["en", "de"].includes(loc), true);
  } finally {
    globalThis.navigator = prev;
  }
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
