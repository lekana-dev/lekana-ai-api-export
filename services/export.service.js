/**
 * Export Service
 * Handles data extraction, transformation, and webhook dispatch
 */
const webhookService = require("./webhook.service");

/**
 * Extract records from input data using field mapping
 * @param {any} inputData - Raw input from previous node
 * @param {Record<string, string>} fieldMapping - Column to path mapping
 * @param {string} unmappedFieldStrategy - "store_as_json", "ignore", "error"
 * @param {Object} options - Additional options
 * @param {boolean} options.flattenFieldsMode - Auto-extract .value from OCR fields
 * @param {boolean} options.includeExtractionMetadata - Store confidence/corrected data
 * @returns {any[]} Extracted records
 */
function extractRecords(
  inputData,
  fieldMapping,
  unmappedFieldStrategy,
  options = {},
) {
  const { flattenFieldsMode = false, includeExtractionMetadata = false } =
    options;
  const records = [];

  // Handle OCR-style output with documents array
  if (inputData.documents && Array.isArray(inputData.documents)) {
    for (const doc of inputData.documents) {
      let result = doc.result || {};

      // If flattenFieldsMode is enabled and we have a fields object, flatten it
      if (flattenFieldsMode && result.fields) {
        result = flattenOcrFields(result, includeExtractionMetadata);
      }

      const record = extractSingleRecord(
        result,
        fieldMapping,
        unmappedFieldStrategy,
      );
      records.push({
        ...record,
        _source_filename: doc.filename || null,
      });
    }
  }
  // Handle direct object input
  else if (typeof inputData === "object" && !Array.isArray(inputData)) {
    let data = inputData;

    // If flattenFieldsMode is enabled and we have a fields object, flatten it
    if (flattenFieldsMode && data.fields) {
      data = flattenOcrFields(data, includeExtractionMetadata);
    }

    const record = extractSingleRecord(
      data,
      fieldMapping,
      unmappedFieldStrategy,
    );
    records.push(record);
  }
  // Handle array input
  else if (Array.isArray(inputData)) {
    for (const item of inputData) {
      let data = item;

      // If flattenFieldsMode is enabled and we have a fields object, flatten it
      if (flattenFieldsMode && data.fields) {
        data = flattenOcrFields(data, includeExtractionMetadata);
      }

      const record = extractSingleRecord(
        data,
        fieldMapping,
        unmappedFieldStrategy,
      );
      records.push(record);
    }
  }

  return records;
}

/**
 * Flatten OCR fields object - extract just the .value from each field
 * @param {Object} ocrResult - OCR result with fields object
 * @param {boolean} includeExtractionMetadata - Whether to store confidence data
 * @returns {Object} Flattened object with field values as top-level properties
 */
function flattenOcrFields(ocrResult, includeExtractionMetadata = false) {
  const flattened = {};
  const extractionMetadata = {};

  // Extract values from fields object
  if (ocrResult.fields && typeof ocrResult.fields === "object") {
    for (const [fieldName, fieldData] of Object.entries(ocrResult.fields)) {
      // Extract just the value
      if (fieldData && typeof fieldData === "object" && "value" in fieldData) {
        flattened[fieldName] = fieldData.value;

        // Collect metadata if requested
        if (includeExtractionMetadata) {
          extractionMetadata[fieldName] = {
            confidence: fieldData.confidence,
            corrected: fieldData.corrected,
            originalValue: fieldData.originalValue,
          };
        }
      } else {
        // If it's not a field object, use as-is
        flattened[fieldName] = fieldData;
      }
    }
  }

  // Add other top-level properties (documentType, outputMode, etc.)
  for (const [key, value] of Object.entries(ocrResult)) {
    if (key !== "fields") {
      flattened[key] = value;
    }
  }

  // Add extraction metadata if requested
  if (includeExtractionMetadata && Object.keys(extractionMetadata).length > 0) {
    flattened._extraction_metadata = extractionMetadata;
  }

  return flattened;
}

/**
 * Extract a single record using field mapping
 * @param {Record<string, any>} data
 * @param {Record<string, string>} fieldMapping
 * @param {string} unmappedFieldStrategy
 * @returns {Record<string, any>}
 */
function extractSingleRecord(data, fieldMapping, unmappedFieldStrategy) {
  const record = {};
  const mappedKeys = new Set();

  // If fieldMapping is provided, use it
  if (fieldMapping && Object.keys(fieldMapping).length > 0) {
    for (const [columnName, fieldPath] of Object.entries(fieldMapping)) {
      // Ensure fieldPath is a string
      const pathStr = fieldPath != null ? String(fieldPath) : "";
      const value = getValueByPath(data, pathStr);
      record[columnName] = value;

      // Track which source keys were mapped
      if (pathStr) {
        const sourceKey = pathStr.split(".")[0].split("[")[0];
        mappedKeys.add(sourceKey);
      }
    }
  } else {
    // No field mapping - use all top-level fields
    for (const [key, value] of Object.entries(data)) {
      // Flatten simple objects, store complex ones as JSON
      if (isPrimitive(value)) {
        record[key] = value;
      } else {
        record[key] = JSON.stringify(value);
      }
      mappedKeys.add(key);
    }
  }

  // Handle unmapped fields
  const unmappedData = {};
  for (const [key, value] of Object.entries(data)) {
    if (!mappedKeys.has(key)) {
      unmappedData[key] = value;
    }
  }

  if (Object.keys(unmappedData).length > 0) {
    switch (unmappedFieldStrategy) {
      case "store_as_json":
        record._extra_data = JSON.stringify(unmappedData);
        break;
      case "error":
        throw new Error(
          `Unmapped fields found: ${Object.keys(unmappedData).join(", ")}`,
        );
      case "ignore":
      default:
        // Do nothing
        break;
    }
  }

  return record;
}

/**
 * Get value from object by dot-notation path
 * Supports array notation like "documents[0].result.field"
 * @param {any} obj
 * @param {string} path
 * @returns {any}
 */
function getValueByPath(obj, path) {
  if (!path) return obj;

  // Ensure path is a string
  const pathStr = typeof path === "string" ? path : String(path);
  const parts = pathStr.split(/\.|\[|\]/).filter(Boolean);
  let current = obj;

  for (const part of parts) {
    if (current === null || current === undefined) {
      return undefined;
    }
    current = current[part];
  }

  return current;
}

/**
 * Check if value is a primitive type
 * @param {any} value
 * @returns {boolean}
 */
function isPrimitive(value) {
  return (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

/**
 * Set a value in an object by dot-notation path, creating nested objects as needed.
 * Supports array notation: e.g. "lineItems[0].description"
 * @param {Object} obj - The target object to set value in
 * @param {string} path - Dot-notation path (e.g. "companyInfo.name")
 * @param {any} value - The value to set
 */
function setValueByPath(obj, path, value) {
  if (!path) return;
  const parts = path.split(/\.|(?=\[)/).filter(Boolean);
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i].replace(/[\[\]]/g, "");
    const nextPart = parts[i + 1];
    if (current[part] === undefined || current[part] === null) {
      // If next segment is an array index, create array; else object
      current[part] = /^\[\d+\]$/.test(nextPart) ? [] : {};
    }
    current = current[part];
  }
  const lastPart = parts[parts.length - 1].replace(/[\[\]]/g, "");
  current[lastPart] = value;
}

/**
 * Build a nested API body from a flat record using a bodyTemplate.
 * Each template entry maps an outputPath to a source OCR field or a static value.
 *
 * @param {Record<string, any>} record - Flat OCR record (after flatten/extract)
 * @param {Array<{outputPath: string, sourceField: string, isStatic: boolean, staticValue: string}>} bodyTemplate
 * @returns {Record<string, any>} Nested body object ready to send to the target API
 *
 * @example
 * buildNestedBody(
 *   { companyName: 'Acme', quotationNumber: '#1234' },
 *   [
 *     { outputPath: 'companyInfo.name', sourceField: 'companyName', isStatic: false },
 *     { outputPath: 'companyInfo.logo', isStatic: true, staticValue: 'logo.png' },
 *     { outputPath: 'quotationDetails.number', sourceField: 'quotationNumber', isStatic: false }
 *   ]
 * )
 * // => { companyInfo: { name: 'Acme', logo: 'logo.png' }, quotationDetails: { number: '#1234' } }
 */
function buildNestedBody(record, bodyTemplate) {
  const body = {};
  for (const mapping of bodyTemplate) {
    if (!mapping || !mapping.outputPath) continue;
    const value = mapping.isStatic
      ? (mapping.staticValue ?? null)
      : (record[mapping.sourceField] ?? null);
    setValueByPath(body, mapping.outputPath, value);
  }
  return body;
}

/**
 * Send records to webhook via webhookService
 * @param {string} url
 * @param {any[]} records
 * @param {object} options
 */
async function sendRecords(url, records, options) {
  // Pass entire options object (including method, headers) to webhookService
  return await webhookService.sendData(url, records, options);
}

module.exports = {
  extractRecords,
  extractSingleRecord,
  getValueByPath,
  setValueByPath,
  flattenOcrFields,
  buildNestedBody,
  sendRecords,
};
