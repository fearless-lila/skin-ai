export const MAX_TRY_ON_PHOTO_BYTES = 10 * 1024 * 1024;
export const MAX_TRY_ON_PHOTO_SIDE_PX = 4096;
export const MIN_TRY_ON_PHOTO_LONG_SIDE_PX = 512;
export const MIN_TRY_ON_PHOTO_SHORT_SIDE_PX = 384;

const ALLOWED_PHOTO_TYPES = new Set(["image/jpeg", "image/png"]);

export async function validateTryOnPhoto(
  file,
  { readDimensions = readImageDimensions } = {}
) {
  if (!file) {
    return invalid("Choose a photograph to continue.");
  }

  if (!ALLOWED_PHOTO_TYPES.has(file.type)) {
    return invalid("Choose a JPG or PNG photograph.");
  }

  if (!Number.isFinite(file.size) || file.size <= 0) {
    return invalid("The selected photograph is empty or unreadable.");
  }

  if (file.size > MAX_TRY_ON_PHOTO_BYTES) {
    return invalid("Choose a photograph smaller than 10 MB.");
  }

  let dimensions;

  try {
    dimensions = await readDimensions(file);
  } catch {
    return invalid("This photograph could not be read. Try another JPG or PNG.");
  }

  const width = Number(dimensions?.width);
  const height = Number(dimensions?.height);

  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    return invalid("This photograph does not contain valid dimensions.");
  }

  const longSide = Math.max(width, height);
  const shortSide = Math.min(width, height);

  if (
    longSide < MIN_TRY_ON_PHOTO_LONG_SIDE_PX ||
    shortSide < MIN_TRY_ON_PHOTO_SHORT_SIDE_PX
  ) {
    return invalid("Choose a photograph that is at least 512 × 384 pixels.");
  }

  if (longSide > MAX_TRY_ON_PHOTO_SIDE_PX) {
    return invalid("Choose a photograph with no side longer than 4096 pixels.");
  }

  return {
    valid: true,
    width,
    height
  };
}

function invalid(error) {
  return { valid: false, error };
}

async function readImageDimensions(file) {
  if (typeof globalThis.createImageBitmap === "function") {
    const bitmap = await globalThis.createImageBitmap(file);
    const dimensions = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return dimensions;
  }

  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const image = new Image();

    image.addEventListener("load", () => {
      resolve({ width: image.naturalWidth, height: image.naturalHeight });
      URL.revokeObjectURL(objectUrl);
    });
    image.addEventListener("error", () => {
      reject(new Error("Image decoding failed."));
      URL.revokeObjectURL(objectUrl);
    });
    image.src = objectUrl;
  });
}
