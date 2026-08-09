import assert from "node:assert/strict";
import test from "node:test";

import {
  TailorSearchError,
  enforceTailorRateLimit,
  findNearbyTailors
} from "../../src/tailors/find-nearby-tailors.js";

test("geocodes a submitted location and returns normalized nearby tailors", async () => {
  const calls = [];
  const result = await findNearbyTailors(
    { query: "SW1A 1AA", latitude: null, longitude: null },
    {
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        if (url.startsWith("https://nominatim.openstreetmap.org/search")) {
          return jsonResponse([
            {
              lat: "51.5010",
              lon: "-0.1416",
              display_name: "Westminster, London, SW1A 1AA, United Kingdom"
            }
          ]);
        }

        return jsonResponse({
          elements: [
            {
              type: "node",
              id: 123,
              lat: 51.503,
              lon: -0.14,
              tags: {
                name: "Access Alterations",
                craft: "tailor",
                "addr:housenumber": "12",
                "addr:street": "Sample Street",
                "addr:city": "London",
                "addr:postcode": "SW1A 2AA",
                wheelchair: "yes",
                "tailor:alteration_service": "yes",
                opening_hours: "Mo-Fr 09:00-17:00",
                website: "https://tailor.example/"
              }
            }
          ]
        });
      }
    }
  );

  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.headers.Referer, "https://skin-ai.pages.dev/");
  assert.match(calls[0].options.headers["User-Agent"], /SkinAI-Hackathon/);
  assert.match(calls[1].url, /craft%22%3D%22tailor/);
  assert.equal(result.locationLabel, "Westminster, London, SW1A 1AA, United Kingdom");
  assert.equal(result.radiusMetres, 8000);
  assert.equal(result.attribution, "© OpenStreetMap contributors");
  assert.equal(result.tailors.length, 1);
  assert.deepEqual(result.tailors[0], {
    id: "node-123",
    name: "Access Alterations",
    category: "Tailor and alterations",
    address: "12 Sample Street, London, SW1A 2AA",
    distanceMetres: result.tailors[0].distanceMetres,
    wheelchair: "yes",
    alterationService: "confirmed",
    openingHours: "Mo-Fr 09:00-17:00",
    phone: null,
    website: "https://tailor.example/",
    mapUrl: "https://www.openstreetmap.org/node/123"
  });
  assert.ok(result.tailors[0].distanceMetres > 0);
});

test("uses browser coordinates without sending a geocoding request", async () => {
  let calls = 0;
  const result = await findNearbyTailors(
    { query: null, latitude: "51.5007", longitude: "-0.1246" },
    {
      fetchImpl: async (url) => {
        calls += 1;
        assert.match(url, /^https:\/\/overpass-api\.de\/api\/interpreter/);
        return jsonResponse({ elements: [] });
      }
    }
  );

  assert.equal(calls, 1);
  assert.equal(result.locationLabel, "your current location");
  assert.deepEqual(result.tailors, []);
});

test("rejects missing, conflicting and invalid locations", async () => {
  for (const input of [
    { query: null, latitude: null, longitude: null },
    { query: "London", latitude: "51.5", longitude: "-0.1" },
    { query: null, latitude: "999", longitude: "-0.1" }
  ]) {
    await assert.rejects(
      findNearbyTailors(input, {
        fetchImpl: async () => {
          throw new Error("must not be called");
        }
      }),
      (error) =>
        error instanceof TailorSearchError &&
        error.code === "INVALID_TAILOR_SEARCH"
    );
  }
});

test("enforces the configured tailor search rate limiter", async () => {
  await assert.rejects(
    enforceTailorRateLimit({
      key: "tailors:visitor",
      limiter: { async limit() { return { success: false }; } }
    }),
    (error) =>
      error instanceof TailorSearchError &&
      error.code === "TAILOR_SEARCH_RATE_LIMITED"
  );
});

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
