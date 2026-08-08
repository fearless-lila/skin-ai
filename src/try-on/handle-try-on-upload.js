import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import uploadRequestSchema from "../../schemas/try-on-upload-request.schema.json" with {
  type: "json"
};
import uploadResponseSchema from "../../schemas/try-on-upload-response.schema.json" with {
  type: "json"
};

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validateUploadRequest = ajv.compile(uploadRequestSchema);
const validateUploadResponse = ajv.compile(uploadResponseSchema);

export class TryOnUploadError extends Error {
  constructor({ code, message, cause = null, errors = [] }) {
    super(message, cause ? { cause } : undefined);
    this.name = "TryOnUploadError";
    this.code = code;
    this.errors = errors ? structuredClone(errors) : [];
  }
}

export async function handleTryOnUpload(
  uploadRequest,
  { catalogue, requestProviderUpload } = {}
) {
  if (!validateUploadRequest(uploadRequest)) {
    throw new TryOnUploadError({
      code: "INVALID_TRY_ON_UPLOAD_REQUEST",
      message: "The virtual try-on upload request is invalid.",
      errors: validateUploadRequest.errors
    });
  }

  if (!catalogue || !Array.isArray(catalogue.products)) {
    throw new TypeError("A trusted catalogue is required.");
  }

  if (typeof requestProviderUpload !== "function") {
    throw new TypeError("requestProviderUpload must be a function.");
  }

  const product = catalogue.products.find(
    ({ id }) => id === uploadRequest.selectedProductId
  );

  if (!product) {
    throw new TryOnUploadError({
      code: "UNKNOWN_PRODUCT_REFERENCE",
      message: "The selected product does not exist in the trusted catalogue."
    });
  }

  if (!hasReadyTryOnConfiguration(product)) {
    throw new TryOnUploadError({
      code: "VIRTUAL_TRY_ON_UNAVAILABLE",
      message: "The selected product is not available for virtual try-on."
    });
  }

  let providerUpload;

  try {
    providerUpload = await requestProviderUpload({ file: uploadRequest.file });
  } catch (cause) {
    throw new TryOnUploadError({
      code: "UPLOAD_PROVIDER_FAILED",
      message: "The temporary upload could not be created.",
      cause
    });
  }

  const response = {
    selectedProductId: product.id,
    fileId: providerUpload?.fileId,
    upload: providerUpload?.upload
  };

  if (!validateUploadResponse(response)) {
    throw new TryOnUploadError({
      code: "INVALID_UPLOAD_PROVIDER_RESPONSE",
      message: "The temporary upload instructions are invalid.",
      errors: validateUploadResponse.errors
    });
  }

  return response;
}

function hasReadyTryOnConfiguration(product) {
  const configuration = product.virtualTryOn;
  return Boolean(
    configuration?.status === "ready" &&
      configuration.provider === "youcam_clothes_v3" &&
      configuration.garmentCategory === "full_body" &&
      Number.isInteger(configuration.referenceImageIndex) &&
      product.imageUrls?.[configuration.referenceImageIndex]
  );
}
