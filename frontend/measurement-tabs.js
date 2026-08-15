const ASSESSMENT_PRIORITY = Object.freeze({
  within_guide: 0,
  alteration_possible: 1,
  alteration_check: 2,
  needs_more_room: 3
});

export function findRecommendedSizeIndex(sizeResults) {
  if (!Array.isArray(sizeResults) || sizeResults.length === 0) {
    throw new TypeError("At least one size result is required.");
  }

  let recommendedIndex = 0;
  for (let index = 1; index < sizeResults.length; index += 1) {
    const currentPriority =
      ASSESSMENT_PRIORITY[sizeResults[index]?.assessment] ??
      Number.MAX_SAFE_INTEGER;
    const recommendedPriority =
      ASSESSMENT_PRIORITY[sizeResults[recommendedIndex]?.assessment] ??
      Number.MAX_SAFE_INTEGER;
    if (currentPriority < recommendedPriority) recommendedIndex = index;
  }

  return recommendedIndex;
}
