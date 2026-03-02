/**
 * Webhook Service
 * Handles sending data to external APIs
 */
const axios = require("axios");

/**
 * Send data to a target API URL
 * @param {string} url - Target API URL
 * @param {object[]} records - Array of records to send
 * @param {object} options - Configuration options
 * @param {string} [options.method] - HTTP Method (POST, PUT, PATCH, etc.)
 * @param {object} [options.headers] - Custom headers
 * @param {object} [options.metadata] - Additional metadata to send
 * @param {boolean} [options.sendAsArray] - If true, wraps records in { records, metadata } envelope.
 *   If false (default), sends records[0] directly as the request body (for APIs that expect a plain object).
 * @returns {Promise<object>} Response summary
 */
async function sendData(url, records, options = {}) {
  const {
    method = "POST",
    headers = {},
    metadata = {},
    sendAsArray = false,
  } = options;

  console.log(
    `[Webhook] Sending ${records.length} records to ${url} via ${method}`,
  );

  // When sendAsArray is false (default), send the first record directly as the body.
  // This is what most external APIs (e.g. swa-api /send-quotation) expect — a plain object, not a wrapped array.
  // When sendAsArray is true, use the legacy { records, metadata } envelope.
  let payload;
  if (sendAsArray) {
    payload = {
      records: records,
      metadata: {
        ...metadata,
        exportedAt: new Date().toISOString(),
        recordCount: records.length,
      },
    };
  } else {
    // Send the first (and typically only) record directly as the body object
    payload = records.length === 1 ? records[0] : records;
  }

  // Merge default headers with user-provided headers
  const requestHeaders = {
    "Content-Type": "application/json",
    "User-Agent": "Lekana-DB-Export-Service/1.0",
    ...headers,
  };

  const startTime = Date.now();

  try {
    const response = await axios({
      method: method,
      url: url,
      data: payload,
      headers: requestHeaders,
      timeout: 30000, // 30 second timeout
    });

    const duration = Date.now() - startTime;
    console.log(`[Webhook] Success: ${response.status} (${duration}ms)`);

    return {
      success: true,
      statusCode: response.status,
      recordsSent: records.length,
      duration,
      responseBody: response.data,
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    console.error(`[Webhook] Failed: ${error.message} (${duration}ms)`);

    // Extract meaningful error details
    const errorDetails = error.response
      ? {
          status: error.response.status,
          data: error.response.data,
        }
      : { message: error.message };

    throw new Error(
      `Webhook export failed (${errorDetails.status || "Network"}): ${JSON.stringify(errorDetails.data || error.message)}`,
    );
  }
}

module.exports = {
  sendData,
};
