import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

test("page states clearly that no token has launched", () => {
  assert.match(html, /has not launched/i);
  assert.match(html, /Risk disclosure/);
});

test("page loads nothing from other websites (privacy + security)", () => {
  // Links people click are fine; files the page LOADS (scripts, styles, images, fonts) must be ours.
  const loads = [...html.matchAll(/<(?:script|img|link)\b[^>]*>/g)].map((m) => m[0]);
  const external = loads.filter((tag) => /(src|href)="(https?:)?\/\//.test(tag));
  assert.deepEqual(external, []);
});

test("no inline scripts or inline styles (blocked by our security policy)", () => {
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/);
  assert.doesNotMatch(html, /\sstyle="/);
});

test("every local file the page references exists", () => {
  for (const [, p] of html.matchAll(/(?:src|href)="(\/[^"#]+)"/g)) {
    assert.ok(existsSync(new URL("../public" + p, import.meta.url)), `missing ${p}`);
  }
});

test("illustration and demo are labeled so nobody mistakes them for real activity", () => {
  assert.match(html, /Illustration only, not live data/);
  assert.match(html, /These towns are fictional and nothing is saved/);
});

test("wallet section promises no seed phrase and no transactions", () => {
  assert.match(html, /never<\/strong> ask for your secret recovery phrase/);
  assert.match(html, /not a transaction/);
});
