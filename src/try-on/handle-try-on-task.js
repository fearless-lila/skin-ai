import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import taskRequestSchema from "../../schemas/try-on-task-request.schema.json" with {
  type: "json"
};
import taskCreateResponseSchema from "../../schemas/try-on-task-create-response.schema.json" with {
  type: "json"
};
import taskStatusResponseSchema from "../../schemas/try-on-task-status-response.schema.json" with {
  type: "json"
};

const TASK_ID_PATTERN = /^[A-Za-z0-9_-]{1,1024}$/;
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validateTaskRequest = ajv.compile(taskRequestSchema);
const validateTaskCreateResponse = ajv.compile(taskCreateResponseSchema);
const validateTaskStatusResponse = ajv.compile(taskStatusResponseSchema);

const PUBLIC_TASK_ERRORS = {
  error_pose: {
    code: "PHOTO_POSE_NOT_DETECTED",
    message:
      "We could not detect a suitable forward-facing pose. Try a clear photograph showing one person."
  },
  error_invalid_src: {
    code: "PHOTO_NOT_SUPPORTED",
    message:
      "This photograph could not be used for virtual try-on. Try another clear, forward-facing photograph."
  },
  error_nsfw_content_detected: {
    code: "PHOTO_SAFETY_CHECK_FAILED",
    message: "This photograph could not pass the provider's image safety checks."
  },
  exceed_max_filesize: {
    code: "PHOTO_TOO_LARGE",
    message: "The photograph was too large for virtual try-on."
  }
};

export class TryOnTaskError extends Error {
  constructor({ code, message, cause = null, errors = [] }) {
    super(message, cause ? { cause } : undefined);
    this.name = "TryOnTaskError";
    this.code = code;
    this.errors = errors ? structuredClone(errors) : [];
  }
}

export async function handleTryOnTaskCreate(
  taskRequest,
  { catalogue, createProviderTask } = {}
) {
  if (!validateTaskRequest(taskRequest)) {
    throw new TryOnTaskError({
      code: "INVALID_TRY_ON_TASK_REQUEST",
      message: "The virtual try-on task request is invalid.",
      errors: validateTaskRequest.errors
    });
  }

  const product = findTryOnProduct(catalogue, taskRequest.selectedProductId);

  if (typeof createProviderTask !== "function") {
    throw new TypeError("createProviderTask must be a function.");
  }

  let providerTask;

  try {
    providerTask = await createProviderTask({
      fileId: taskRequest.fileId,
      referenceImageUrl:
        product.imageUrls[product.virtualTryOn.referenceImageIndex],
      garmentCategory: product.virtualTryOn.garmentCategory
    });
  } catch (cause) {
    throw new TryOnTaskError({
      code: "TASK_PROVIDER_FAILED",
      message: "The virtual try-on task could not be created.",
      cause
    });
  }

  const response = {
    selectedProductId: product.id,
    taskId: providerTask?.taskId,
    status: "processing"
  };

  if (!validateTaskCreateResponse(response)) {
    throw new TryOnTaskError({
      code: "INVALID_TASK_PROVIDER_RESPONSE",
      message: "The virtual try-on task identifier is invalid.",
      errors: validateTaskCreateResponse.errors
    });
  }

  return response;
}

export async function handleTryOnTaskStatus(
  taskId,
  { getProviderTask } = {}
) {
  if (!TASK_ID_PATTERN.test(taskId)) {
    throw new TryOnTaskError({
      code: "INVALID_TRY_ON_TASK_ID",
      message: "The virtual try-on task identifier is invalid."
    });
  }

  if (typeof getProviderTask !== "function") {
    throw new TypeError("getProviderTask must be a function.");
  }

  let providerTask;

  try {
    providerTask = await getProviderTask(taskId);
  } catch (cause) {
    throw new TryOnTaskError({
      code: "TASK_PROVIDER_FAILED",
      message: "The virtual try-on task status could not be checked.",
      cause
    });
  }

  const response = buildStatusResponse(taskId, providerTask);

  if (!validateTaskStatusResponse(response)) {
    throw new TryOnTaskError({
      code: "INVALID_TASK_PROVIDER_RESPONSE",
      message: "The virtual try-on task status is invalid.",
      errors: validateTaskStatusResponse.errors
    });
  }

  return response;
}

function findTryOnProduct(catalogue, productId) {
  if (!catalogue || !Array.isArray(catalogue.products)) {
    throw new TypeError("A trusted catalogue is required.");
  }

  const product = catalogue.products.find(({ id }) => id === productId);

  if (!product) {
    throw new TryOnTaskError({
      code: "UNKNOWN_PRODUCT_REFERENCE",
      message: "The selected product does not exist in the trusted catalogue."
    });
  }

  const configuration = product.virtualTryOn;
  if (
    configuration?.status !== "ready" ||
    configuration.provider !== "youcam_clothes_v3" ||
    configuration.garmentCategory !== "full_body" ||
    !Number.isInteger(configuration.referenceImageIndex) ||
    !isHttpsUrl(product.imageUrls?.[configuration.referenceImageIndex])
  ) {
    throw new TryOnTaskError({
      code: "VIRTUAL_TRY_ON_UNAVAILABLE",
      message: "The selected product is not available for virtual try-on."
    });
  }

  return product;
}

function buildStatusResponse(taskId, providerTask) {
  if (providerTask?.status === "succeeded") {
    return {
      taskId,
      status: "succeeded",
      resultUrl: providerTask.resultUrl,
      error: null
    };
  }

  if (providerTask?.status === "failed") {
    return {
      taskId,
      status: "failed",
      resultUrl: null,
      error:
        PUBLIC_TASK_ERRORS[providerTask.errorCode] ?? {
          code: "TRY_ON_PROCESSING_FAILED",
          message:
            "The virtual try-on could not be generated from these images. Try another photograph."
        }
    };
  }

  return {
    taskId,
    status: providerTask?.status,
    resultUrl: null,
    error: null
  };
}

function isHttpsUrl(value) {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}
