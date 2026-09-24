import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

test("page explains the token, holders, launchpad and official list", () => {
  for (const id of ["token", "holders", "wallet", "launchpad", "check"]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /No rug pull/);
  assert.match(html, /Founding Supporter/);
});

test("no links to the source code repository", () => {
  assert.doesNotMatch(html, /github\.com/i);
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

test("wallet section: no seed phrase, signing is not a transaction", () => {
  assert.match(html, /never ask for your recovery phrase/);
  assert.match(html, /isn't a transaction/);
});

test("claim-your-city section: rules are stated plainly, location is not kept", () => {
  for (const id of ["cities", "city-canvas", "city-q", "claim-btn", "add-form"]) assert.ok(html.includes(`id="${id}"`), id);
  assert.match(html, /One wallet\. One city\./);
  assert.match(html, /1,000,000\+ \$VICINITY/);
  assert.match(html, /never save it/);
  assert.match(html, /GeoNames/);
});

test("map v2: zoom controls, coin preview, live feed, moderator row, scripts in order", () => {
  for (const id of ["map-in", "map-out", "map-reset", "coin-preview", "coin-ticker", "claim-feed", "mod-row"]) assert.ok(html.includes(`id="${id}"`), id);
  assert.match(html, /Sample only/);
  assert.match(html, /VPNs are blocked/);
  const order = [...html.matchAll(/<script src="\/([a-z]+)\.js"/g)].map((m) => m[1]);
  assert.deepEqual(order, ["theme", "app", "ticker", "cities"]);
});

test("theme: toggle in the header, theme script runs before paint (not deferred)", () => {
  assert.match(html, /data-theme-toggle/);
  assert.match(html, /<script src="\/theme\.js"><\/script>\s*<\/head>/);
  const css = readFileSync(new URL("../public/style.css", import.meta.url), "utf8");
  assert.match(css, /:root\[data-theme="light"\]/);
});
