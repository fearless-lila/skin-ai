const ACCESS_FIELDS = [
  "closureType",
  "closureLocation",
  "dressingMethod",
  "gripFeature",
  "openingExtent"
];

export const MATCH_STATUS = Object.freeze({
  COMPATIBLE: "compatible",
  CONFLICT: "conflict",
  MISSING_INFORMATION: "missing_information"
});

/**
 * Match validated user requirements against validated catalogue products.
 *
 * The LLM is deliberately absent from this function. It accepts normalized
 * data and returns explainable, deterministic results.
 */
export function matchProducts(requirements, products) {
  assertMatchingInput(requirements, products);

  const indexedResults = products.map((product, index) => ({
    index,
    result: matchProduct(requirements, product)
  }));

  const byPreferenceThenInputOrder = (left, right) =>
    right.result.preferenceScore - left.result.preferenceScore ||
    left.index - right.index;

  return {
    compatibleProducts: indexedResults
      .filter(({ result }) => result.status === MATCH_STATUS.COMPATIBLE)
      .sort(byPreferenceThenInputOrder)
      .map(({ result }) => result),
    productsWithMissingInformation: indexedResults
      .filter(
        ({ result }) => result.status === MATCH_STATUS.MISSING_INFORMATION
      )
      .sort(byPreferenceThenInputOrder)
      .map(({ result }) => result),
    rejectedProducts: indexedResults
      .filter(({ result }) => result.status === MATCH_STATUS.CONFLICT)
      .map(({ result }) => result)
  };
}

export function matchProduct(requirements, product) {
  assertRequirements(requirements);

  if (!product || typeof product !== "object") {
    throw new TypeError("Product must be an object.");
  }

  const result = {
    productId: product.id,
    productName: product.name,
    status: MATCH_STATUS.COMPATIBLE,
    compatibleSizes: [],
    confirmedMatches: [],
    conflicts: [],
    missingInformation: [],
    preferenceMatches: [],
    preferenceScore: 0
  };

  evaluateGarmentType(requirements, product, result);
  evaluateRequiredAccess(requirements, product, result);
  evaluateExcludedAccess(requirements, product, result);
  evaluatePreferences(requirements, product, result);
  evaluateMeasurements(requirements, product, result);

  if (result.conflicts.length > 0) {
    result.status = MATCH_STATUS.CONFLICT;
  } else if (result.missingInformation.length > 0) {
    result.status = MATCH_STATUS.MISSING_INFORMATION;
  }

  return result;
}

function evaluateGarmentType(requirements, product, result) {
  if (requirements.garmentTypes.includes(product.garmentType)) {
    result.confirmedMatches.push({
      field: "garmentType",
      requirementType: "required",
      expected: requirements.garmentTypes,
      actual: product.garmentType
    });
    return;
  }

  result.conflicts.push({
    field: "garmentType",
    requirementType: "required",
    expected: requirements.garmentTypes,
    actual: product.garmentType,
    reason: "wrong_garment_type"
  });
}

function evaluateRequiredAccess(requirements, product, result) {
  for (const field of ACCESS_FIELDS) {
    const allowedValues = requirements.requiredAccess[field] ?? [];

    if (allowedValues.length === 0) {
      continue;
    }

    const productFact = product.access?.[field];

    if (!hasConfirmedValue(productFact)) {
      result.missingInformation.push({
        field: `access.${field}`,
        requirementType: "required",
        expected: allowedValues,
        reason: "unknown_product_fact"
      });
      continue;
    }

    if (allowedValues.includes(productFact.value)) {
      result.confirmedMatches.push({
        field: `access.${field}`,
        requirementType: "required",
        expected: allowedValues,
        actual: productFact.value,
        evidence: copyEvidence(productFact)
      });
      continue;
    }

    result.conflicts.push({
      field: `access.${field}`,
      requirementType: "required",
      expected: allowedValues,
      actual: productFact.value,
      reason: "required_value_not_met",
      evidence: copyEvidence(productFact)
    });
  }
}

function evaluateExcludedAccess(requirements, product, result) {
  for (const field of ACCESS_FIELDS) {
    const excludedValues = requirements.excludedAccess[field] ?? [];

    if (excludedValues.length === 0) {
      continue;
    }

    const productFact = product.access?.[field];

    if (!hasConfirmedValue(productFact)) {
      result.missingInformation.push({
        field: `access.${field}`,
        requirementType: "excluded",
        expected: excludedValues,
        reason: "cannot_verify_exclusion"
      });
      continue;
    }

    if (excludedValues.includes(productFact.value)) {
      result.conflicts.push({
        field: `access.${field}`,
        requirementType: "excluded",
        expected: excludedValues,
        actual: productFact.value,
        reason: "excluded_value_present",
        evidence: copyEvidence(productFact)
      });
      continue;
    }

    result.confirmedMatches.push({
      field: `access.${field}`,
      requirementType: "excluded",
      expected: excludedValues,
      actual: productFact.value,
      evidence: copyEvidence(productFact)
    });
  }
}

function evaluatePreferences(requirements, product, result) {
  for (const field of ACCESS_FIELDS) {
    const preferredValues = requirements.preferredAccess[field] ?? [];

    if (preferredValues.length === 0) {
      continue;
    }

    const productFact = product.access?.[field];

    if (
      hasConfirmedValue(productFact) &&
      preferredValues.includes(productFact.value)
    ) {
      result.preferenceMatches.push({
        field: `access.${field}`,
        expected: preferredValues,
        actual: productFact.value,
        evidence: copyEvidence(productFact)
      });
      result.preferenceScore += 1;
    }
  }
}

function evaluateMeasurements(requirements, product, result) {
  const measurementRequirements = requirements.requiredMeasurements;

  if (measurementRequirements.length === 0) {
    return;
  }

  const measurementsBySize = groupMeasurementsBySize(product.measurements ?? []);
  const sizeEvaluations = (product.sizes ?? []).map((size) => {
    const valuesForSize = measurementsBySize.get(size) ?? new Map();
    const missingNames = [];
    const outOfRange = [];
    const confirmed = [];

    for (const requirement of measurementRequirements) {
      const measurement = valuesForSize.get(requirement.name);

      if (!measurement) {
        missingNames.push(requirement.name);
        continue;
      }

      if (measurementIsWithinRange(measurement.valueCm, requirement)) {
        confirmed.push(copyMeasurementEvidence(measurement));
      } else {
        outOfRange.push(copyMeasurementEvidence(measurement));
      }
    }

    return {
      size,
      missingNames,
      outOfRange,
      confirmed,
      complete: missingNames.length === 0,
      compatible: missingNames.length === 0 && outOfRange.length === 0
    };
  });

  const compatibleSizes = sizeEvaluations.filter(
    (evaluation) => evaluation.compatible
  );

  if (compatibleSizes.length > 0) {
    result.compatibleSizes = compatibleSizes.map(({ size }) => size);
    result.confirmedMatches.push({
      field: "measurements",
      requirementType: "required",
      expected: measurementRequirements,
      actual: compatibleSizes.map(({ size, confirmed }) => ({
        size,
        measurements: confirmed
      }))
    });
    return;
  }

  const hasIncompleteSize = sizeEvaluations.some(
    (evaluation) => !evaluation.complete
  );

  if (hasIncompleteSize || sizeEvaluations.length === 0) {
    result.missingInformation.push({
      field: "measurements",
      requirementType: "required",
      expected: measurementRequirements,
      reason: "insufficient_measurement_data",
      details: sizeEvaluations.map(({ size, missingNames, outOfRange }) => ({
        size,
        missingNames,
        knownOutOfRange: outOfRange
      }))
    });
    return;
  }

  result.conflicts.push({
    field: "measurements",
    requirementType: "required",
    expected: measurementRequirements,
    reason: "all_documented_sizes_out_of_range",
    actual: sizeEvaluations.map(({ size, outOfRange }) => ({
      size,
      measurements: outOfRange
    }))
  });
}

function groupMeasurementsBySize(measurements) {
  const grouped = new Map();

  for (const measurement of measurements) {
    if (!grouped.has(measurement.size)) {
      grouped.set(measurement.size, new Map());
    }

    grouped.get(measurement.size).set(measurement.name, measurement);
  }

  return grouped;
}

function measurementIsWithinRange(valueCm, requirement) {
  if (
    requirement.minimumCm !== undefined &&
    valueCm < requirement.minimumCm
  ) {
    return false;
  }

  if (
    requirement.maximumCm !== undefined &&
    valueCm > requirement.maximumCm
  ) {
    return false;
  }

  return true;
}

function hasConfirmedValue(productFact) {
  return Boolean(
    productFact &&
      productFact.status !== "unknown" &&
      productFact.value !== "unknown"
  );
}

function copyEvidence(productFact) {
  return {
    status: productFact.status,
    sourceText: productFact.sourceText,
    sourceUrl: productFact.sourceUrl,
    ...(productFact.verifiedAt
      ? { verifiedAt: productFact.verifiedAt }
      : {})
  };
}

function copyMeasurementEvidence(measurement) {
  return {
    size: measurement.size,
    name: measurement.name,
    valueCm: measurement.valueCm,
    status: measurement.status,
    sourceUrl: measurement.sourceUrl,
    ...(measurement.sourceText
      ? { sourceText: measurement.sourceText }
      : {}),
    ...(measurement.verifiedAt
      ? { verifiedAt: measurement.verifiedAt }
      : {})
  };
}

function assertMatchingInput(requirements, products) {
  assertRequirements(requirements);

  if (!Array.isArray(products)) {
    throw new TypeError("Products must be an array.");
  }
}

function assertRequirements(requirements) {
  if (!requirements || typeof requirements !== "object") {
    throw new TypeError("Requirements must be an object.");
  }

  if (
    !Array.isArray(requirements.garmentTypes) ||
    requirements.garmentTypes.length === 0
  ) {
    throw new TypeError("At least one garment type is required.");
  }

  for (const key of ["requiredAccess", "excludedAccess", "preferredAccess"]) {
    if (!requirements[key] || typeof requirements[key] !== "object") {
      throw new TypeError(`${key} must be an object.`);
    }
  }

  if (!Array.isArray(requirements.requiredMeasurements)) {
    throw new TypeError("requiredMeasurements must be an array.");
  }

  for (const field of ACCESS_FIELDS) {
    const requiredValues = requirements.requiredAccess[field] ?? [];
    const excludedValues = requirements.excludedAccess[field] ?? [];
    const preferredValues = requirements.preferredAccess[field] ?? [];

    if (
      !Array.isArray(requiredValues) ||
      !Array.isArray(excludedValues) ||
      !Array.isArray(preferredValues)
    ) {
      throw new TypeError(`Access requirement ${field} must be an array.`);
    }

    const contradiction = requiredValues.find((value) =>
      excludedValues.includes(value)
    );

    if (contradiction !== undefined) {
      throw new TypeError(
        `Contradictory ${field} requirement: ${contradiction} is both required and excluded.`
      );
    }
  }

  for (const measurement of requirements.requiredMeasurements) {
    if (
      measurement.minimumCm !== undefined &&
      measurement.maximumCm !== undefined &&
      measurement.minimumCm > measurement.maximumCm
    ) {
      throw new TypeError(
        `Invalid ${measurement.name} range: minimumCm exceeds maximumCm.`
      );
    }
  }
}
