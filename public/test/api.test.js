import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { handleApi } from "../src/index.js";

const req = (path, method = "GET") => new Request("https://example.test" + path, { method });

test("health endpoint returns ok", async () => {
  const res = await handleApi(req("/api/health"));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, service: "vicinity-map", milestone: 1 });
  assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff");
});

test("health endpoint rejects POST", async () => {
  const res = await handleApi(req("/api/health", "POST"));
  assert.equal(res.status, 405);
});

test("unknown API route is 404", async () => {
  const res = await handleApi(req("/api/nope"));
  assert.equal(res.status, 404);
});

test("non-API requests go to static assets with security headers", async () => {
  const env = { ASSETS: { fetch: async () => new Response("<h1>hi</h1>", { headers: { "Content-Type": "text/html" } }) } };
  const res = await worker.fetch(req("/"), env);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "<h1>hi</h1>");
  assert.equal(res.headers.get("X-Frame-Options"), "DENY");
});

test("crashes become a safe 500 without leaking details", async () => {
  const env = { ASSETS: { fetch: async () => { throw new Error("secret detail"); } } };
  const orig = console.error; console.error = () => {};
  const res = await worker.fetch(req("/"), env);
  console.error = orig;
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { error: "internal_error" });
});
