import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_TRY_ON_PHOTO_BYTES,
  validateTryOnPhoto
} from "../../frontend/photo-selection.js";

function photo(overrides = {}) {
  return {
    name: "person.jpg",
    type: "image/jpeg",
    size: 2 * 1024 * 1024,
    ...overrides
  };
}

test("accepts a supported photograph with valid dimensions", async () => {
  const result = await validateTryOnPhoto(photo(), {
    readDimensions: async () => ({ width: 1024, height: 1536 })
  });

  assert.deepEqual(result, {
    valid: true,
    width: 1024,
    height: 1536
  });
});

test("rejects unsupported file types before reading dimensions", async () => {
  let dimensionReads = 0;
  const result = await validateTryOnPhoto(photo({ type: "image/webp" }), {
    readDimensions: async () => {
      dimensionReads += 1;
      return { width: 1024, height: 1536 };
    }
  });

  assert.equal(result.valid, false);
  assert.match(result.error, /JPG or PNG/);
  assert.equal(dimensionReads, 0);
});

test("rejects photographs larger than 10 MB", async () => {
  const result = await validateTryOnPhoto(
    photo({ size: MAX_TRY_ON_PHOTO_BYTES + 1 }),
    { readDimensions: async () => ({ width: 1024, height: 1536 }) }
  );

  assert.equal(result.valid, false);
  assert.match(result.error, /smaller than 10 MB/);
});

test("rejects photographs outside the supported dimensions", async (t) => {
  await t.test("too small", async () => {
    const result = await validateTryOnPhoto(photo(), {
      readDimensions: async () => ({ width: 500, height: 300 })
    });
    assert.equal(result.valid, false);
    assert.match(result.error, /at least 512/);
  });

  await t.test("too large", async () => {
    const result = await validateTryOnPhoto(photo(), {
      readDimensions: async () => ({ width: 4097, height: 3000 })
    });
    assert.equal(result.valid, false);
    assert.match(result.error, /4096/);
  });
});

test("returns a controlled error when the browser cannot decode the image", async () => {
  const result = await validateTryOnPhoto(photo(), {
    readDimensions: async () => {
      throw new Error("decode failure");
    }
  });

  assert.equal(result.valid, false);
  assert.match(result.error, /could not be read/);
});
