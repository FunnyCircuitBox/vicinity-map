import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { handleApi, handleVerify } from "../src/index.js";
import { base58Encode, buildMessage, parseMessage } from "../src/solana.js";

const HOST = "vicinity.test";
const req = (path, init = {}) => new Request(`https://${HOST}${path}`, init);

async function newWallet() {
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const address = base58Encode(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)));
  const sign = async (text) =>
    Buffer.from(await crypto.subtle.sign({ name: "Ed25519" }, kp.privateKey, new TextEncoder().encode(text))).toString("base64");
  return { address, sign };
}
const postVerify = (body) =>
  handleVerify(req("/api/verify", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }));

test("health endpoint returns ok with security headers", async () => {
  const res = await handleApi(req("/api/health"));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, service: "vicinity-map", milestone: 1 });
  assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff");
});

test("wrong method is rejected; unknown route is 404", async () => {
  assert.equal((await handleApi(req("/api/health", { method: "POST" }))).status, 405);
  assert.equal((await handleApi(req("/api/verify"))).status, 405);
  assert.equal((await handleApi(req("/api/nope"))).status, 404);
});

test("official list says no token and no socials yet", async () => {
  const data = await (await handleApi(req("/api/official"))).json();
  assert.equal(data.tokenContract, null);
  assert.deepEqual(data.socials, []);
});

test("link checker: official site, official GitHub, fakes", async () => {
  const check = async (q) => (await (await handleApi(req("/api/check?q=" + encodeURIComponent(q)))).json()).verdict;
  assert.equal(await check("https://vicinity-map.noyonsakibul.workers.dev/"), "official");
  assert.equal(await check("github.com/FunnyCircuitBox/vicinity-map"), "official");
  assert.equal(await check("https://github.com/FunnyCircuitBox/vicinity-map-fake"), "not_official");
  assert.equal(await check("vicinity-airdrop.xyz"), "not_official");
  assert.equal(await check("@vicinity_official"), "not_official");
  assert.equal(await check("So11111111111111111111111111111111111111112"), "not_official");
  assert.equal(await check("http://vicinity-map.noyonsakibul.workers.dev"), "warning");
  assert.equal(await check(""), "empty");
});

test("message endpoint builds a parseable message for this site", async () => {
  const { address } = await newWallet();
  const { message } = await (await handleApi(req("/api/message?address=" + address))).json();
  const parsed = parseMessage(message);
  assert.equal(parsed.host, HOST);
  assert.equal(parsed.address, address);
  assert.equal((await handleApi(req("/api/message?address=nope"))).status, 400);
});

test("verify: a real signature from the right wallet passes", async () => {
  const w = await newWallet();
  const message = buildMessage({ host: HOST, address: w.address, nonce: "abcdefghijklmnop1234", issuedAt: new Date().toISOString() });
  const res = await postVerify({ address: w.address, message, signature: await w.sign(message) });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).verified, true);
});

test("verify: someone else's signature fails", async () => {
  const w = await newWallet(), attacker = await newWallet();
  const message = buildMessage({ host: HOST, address: w.address, nonce: "abcdefghijklmnop1234", issuedAt: new Date().toISOString() });
  const res = await postVerify({ address: w.address, message, signature: await attacker.sign(message) });
  assert.equal(res.status, 401);
});

test("verify: tampered, expired, or other-site messages fail", async () => {
  const w = await newWallet();
  const fresh = new Date().toISOString();
  const good = buildMessage({ host: HOST, address: w.address, nonce: "abcdefghijklmnop1234", issuedAt: fresh });
  const sig = await w.sign(good);
  assert.equal((await postVerify({ address: w.address, message: good.replace("Vicinity", "Vicinlty"), signature: sig })).status, 400);

  const old = buildMessage({ host: HOST, address: w.address, nonce: "abcdefghijklmnop1234", issuedAt: new Date(Date.now() - 11 * 60e3).toISOString() });
  assert.equal((await (await postVerify({ address: w.address, message: old, signature: await w.sign(old) })).json()).error, "expired");

  const other = buildMessage({ host: "evil.example", address: w.address, nonce: "abcdefghijklmnop1234", issuedAt: fresh });
  assert.equal((await (await postVerify({ address: w.address, message: other, signature: await w.sign(other) })).json()).error, "wrong_site");
});

test("verify: junk input is rejected safely", async () => {
  assert.equal((await handleVerify(req("/api/verify", { method: "POST", body: "{not json" }))).status, 400);
  assert.equal((await postVerify({ address: "x", message: "y", signature: "z" })).status, 400);
  assert.equal((await handleVerify(req("/api/verify", { method: "POST", body: "x".repeat(5000) }))).status, 413);
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
