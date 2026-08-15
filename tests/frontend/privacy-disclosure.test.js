import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const indexHtml = readFileSync(
  new URL("../../frontend/index.html", import.meta.url),
  "utf8"
);
const privacyHtml = readFileSync(
  new URL("../../frontend/privacy.html", import.meta.url),
  "utf8"
);
const appSource = readFileSync(
  new URL("../../frontend/app.js", import.meta.url),
  "utf8"
);

test("the clothing conversation discloses provider processing", () => {
  assert.match(indexHtml, /Messages are sent to OpenAI/);
  assert.match(indexHtml, /href="\.\/privacy\.html"/);
  assert.match(privacyHtml, /OpenAI's API data controls/);
  assert.match(privacyHtml, /Saved measurements/);
});

test("photo consent requires authority and links provider information", () => {
  assert.match(appSource, /I confirm that I am the person shown/);
  assert.match(appSource, /or I have their permission/);
  assert.match(appSource, /YouCam privacy policy/);
  assert.match(privacyHtml, /YouCam API terms/);
});

test("the privacy notice documents every user-data feature", () => {
  for (const heading of [
    "Clothing conversation",
    "Saved measurements",
    "Virtual try-on photograph",
    "Alteration-service location",
    "Hosting and security"
  ]) {
    assert.match(privacyHtml, new RegExp(`>${heading}<`), heading);
  }
});
