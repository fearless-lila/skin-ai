export const YOUCAM_CLOTHES_GARMENT_CATEGORIES = Object.freeze([
  "upper_body",
  "lower_body",
  "full_body"
]);

const supportedCategories = new Set(YOUCAM_CLOTHES_GARMENT_CATEGORIES);

export function isSupportedYouCamGarmentCategory(value) {
  return supportedCategories.has(value);
}

export function hasReadyTryOnConfiguration(product) {
  const configuration = product?.virtualTryOn;
  const referenceImageUrl =
    product?.imageUrls?.[configuration?.referenceImageIndex];

  return Boolean(
    configuration?.status === "ready" &&
      configuration.provider === "youcam_clothes_v3" &&
      isSupportedYouCamGarmentCategory(configuration.garmentCategory) &&
      Number.isInteger(configuration.referenceImageIndex) &&
      isHttpsUrl(referenceImageUrl)
  );
}

function isHttpsUrl(value) {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}
