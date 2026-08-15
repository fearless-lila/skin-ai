export const MEASUREMENT_FIELDS = Object.freeze([
  { name: "chest", label: "Chest", help: "Around the fullest part" },
  { name: "waist", label: "Waist", help: "Around your natural waist" },
  { name: "hip", label: "Hips", help: "Around the fullest part" },
  {
    name: "shoulder_width",
    label: "Shoulder width",
    help: "Across your back, shoulder point to shoulder point"
  },
  {
    name: "sleeve_length",
    label: "Sleeve length",
    help: "Shoulder point to wrist"
  },
  { name: "inside_leg", label: "Inside leg", help: "Crotch to ankle" },
  {
    name: "garment_length",
    label: "Preferred garment length",
    help: "Shoulder or waist to your preferred hem"
  }
]);

const PROFILE_FIELD_NAMES = new Set(MEASUREMENT_FIELDS.map(({ name }) => name));
const REQUIRED_PROFILE_FIELD_NAMES = Object.freeze(["chest", "waist"]);
const CIRCUMFERENCE_EASE_CM = Object.freeze({
  chest: { minimum: 6, comfortableMaximum: 14 },
  waist: { minimum: 2, comfortableMaximum: 10 },
  hip: { minimum: 4, comfortableMaximum: 12 }
});

export function normalizeMeasurementProfile(values) {
  const profile = {};

  for (const { name } of MEASUREMENT_FIELDS) {
    const rawValue = values?.[name];
    if (rawValue === undefined || rawValue === null || rawValue === "") continue;

    const valueCm = Number(rawValue);
    if (!Number.isFinite(valueCm) || valueCm < 20 || valueCm > 250) {
      throw new TypeError("Each measurement must be between 20 cm and 250 cm.");
    }
    profile[name] = roundToHalfCentimetre(valueCm);
  }

  if (REQUIRED_PROFILE_FIELD_NAMES.some((name) => profile[name] === undefined)) {
    throw new TypeError(
      "Enter your chest and waist measurements. Other measurements are optional."
    );
  }

  return profile;
}

export function isUsableMeasurementProfile(profile) {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    return false;
  }

  const entries = Object.entries(profile);
  return (
    REQUIRED_PROFILE_FIELD_NAMES.every(
      (name) => Number.isFinite(profile[name])
    ) &&
    entries.every(
      ([name, value]) =>
        PROFILE_FIELD_NAMES.has(name) &&
        Number.isFinite(value) &&
        value >= 20 &&
        value <= 250
    )
  );
}

export function compareProductMeasurements(profile, garmentMeasurements) {
  if (!isUsableMeasurementProfile(profile)) {
    throw new TypeError("A valid measurement profile is required.");
  }
  if (!Array.isArray(garmentMeasurements)) {
    throw new TypeError("Garment measurements must be an array.");
  }

  const grouped = new Map();
  for (const measurement of garmentMeasurements) {
    if (
      !measurement ||
      typeof measurement.size !== "string" ||
      !PROFILE_FIELD_NAMES.has(measurement.name) ||
      !Number.isFinite(measurement.valueCm) ||
      profile[measurement.name] === undefined
    ) {
      continue;
    }

    if (!grouped.has(measurement.size)) grouped.set(measurement.size, []);
    grouped.get(measurement.size).push(
      compareMeasurement(
        measurement.name,
        profile[measurement.name],
        measurement.valueCm
      )
    );
  }

  return [...grouped].map(([size, comparisons]) => ({
    size,
    comparisons,
    assessment: summarizeSize(comparisons)
  }));
}

function compareMeasurement(name, bodyValueCm, garmentValueCm) {
  const differenceCm = roundToHalfCentimetre(garmentValueCm - bodyValueCm);
  const ease = CIRCUMFERENCE_EASE_CM[name];

  if (ease) {
    if (differenceCm < ease.minimum) {
      const extraNeededCm = roundToHalfCentimetre(ease.minimum - differenceCm);
      return {
        name,
        bodyValueCm,
        garmentValueCm,
        differenceCm,
        status: "needs_more_room",
        guidance: `Ask whether at least ${formatCm(extraNeededCm)} can be added; seam allowance and stretch are not documented here.`
      };
    }

    if (differenceCm > ease.comfortableMaximum) {
      const potentialReductionCm = roundToHalfCentimetre(
        differenceCm - ease.comfortableMaximum
      );
      return {
        name,
        bodyValueCm,
        garmentValueCm,
        differenceCm,
        status: "roomy",
        guidance: `There is ${formatCm(differenceCm)} of total room. A tailor could assess taking in up to about ${formatCm(potentialReductionCm)} while retaining a typical ease allowance.`
      };
    }

    return {
      name,
      bodyValueCm,
      garmentValueCm,
      differenceCm,
      status: "within_guide",
      guidance: `${formatCm(differenceCm)} of total room is within the starting ease guide for this measurement.`
    };
  }

  if (differenceCm > 1) {
    return {
      name,
      bodyValueCm,
      garmentValueCm,
      differenceCm,
      status: "longer",
      guidance: `The documented length is about ${formatCm(differenceCm)} longer; shortening may be possible.`
    };
  }

  if (differenceCm < -1) {
    return {
      name,
      bodyValueCm,
      garmentValueCm,
      differenceCm,
      status: "shorter",
      guidance: `The documented length is about ${formatCm(Math.abs(differenceCm))} shorter; ask whether the hem or construction allows lengthening.`
    };
  }

  return {
    name,
    bodyValueCm,
    garmentValueCm,
    differenceCm,
    status: "within_guide",
    guidance: "The documented garment measurement is close to your saved measurement."
  };
}

function summarizeSize(comparisons) {
  if (comparisons.some(({ status }) => status === "needs_more_room")) {
    return "needs_more_room";
  }
  if (comparisons.some(({ status }) => status === "shorter")) {
    return "alteration_check";
  }
  if (comparisons.some(({ status }) => ["roomy", "longer"].includes(status))) {
    return "alteration_possible";
  }
  return "within_guide";
}

function roundToHalfCentimetre(value) {
  return Math.round(value * 2) / 2;
}

function formatCm(value) {
  return `${Number.isInteger(value) ? value : value.toFixed(1)} cm`;
}
