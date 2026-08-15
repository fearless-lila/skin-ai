import assert from "node:assert/strict";
import test from "node:test";

import { hasAlterationIntent } from "../../frontend/intent-navigation.js";

test("detects direct requests for alteration support", () => {
  assert.equal(hasAlterationIntent("Can you help me find a nearby tailor?"), true);
  assert.equal(hasAlterationIntent("I need this dress hemmed"), true);
  assert.equal(hasAlterationIntent("Where can I get clothing alterations?"), true);
});

test("detects garment-specific adjustment requests", () => {
  assert.equal(hasAlterationIntent("I need to shorten these sleeves"), true);
  assert.equal(hasAlterationIntent("Can the waist be taken in?"), true);
  assert.equal(hasAlterationIntent("I want to replace the zip on my dress"), true);
});

test("does not redirect unrelated conversation", () => {
  assert.equal(hasAlterationIntent("Show me a pink dress"), false);
  assert.equal(hasAlterationIntent("Adjust the search results"), false);
  assert.equal(hasAlterationIntent(""), false);
  assert.equal(hasAlterationIntent(null), false);
});
