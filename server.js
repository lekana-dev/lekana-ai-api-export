/**
 * DB Export Service - Main Entry Point
 * Exports workflow data to external APIs provided by the User
 * Port: 4005
 */
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const {
  handleAuthError,
  extractUserInfo,
} = require("./middleware/auth.middleware");
const exportService = require("./services/export.service");
const geminiService = require("./services/gemini.service");

const app = express();
const PORT = process.env.PORT || 4005;
const SERVICE_VERSION = "2.1.0-webhook-flexible";

// Middleware
app.use(express.json({ limit: "50mb" }));
app.use(cors());

// ============================================
// Health Check Endpoint (Public)
// ============================================
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "lekana-export-service",
    version: SERVICE_VERSION,
  });
});

// ============================================
// Main Export Processing Endpoint
// Follows ServiceRequest/ServiceResponse contract
// ============================================
app.post(
  "/api/v1/process",
  //checkJwt, // Uncomment for production
  handleAuthError,
  extractUserInfo,
  async (req, res) => {
    const startTime = Date.now();

    try {
      const {
        executionId,
        nodeId,
        workflowId,
        userId,
        input = {},
        config = {},
      } = req.body;

      // Extract config
      const {
        targetApiUrl, // REPLACES databaseUrl
        targetMethod = "POST", // HTTP Method (POST, PUT, PATCH, etc.)
        headers = {}, // Custom headers object
        authHeader, // Legacy/Convenience: Authorization header
        targetFields = [], // OPTIONAL: List of expected fields for Smart Mapping
        fieldMapping = {},
        bodyTemplate = [], // OPTIONAL: Nested body template for manual body construction
        includeMetadata = true,
        unmappedFieldStrategy = "store_as_json", // "store_as_json", "ignore", "error"
        flattenFieldsMode = false, // Auto-extract .value from OCR fields
        includeExtractionMetadata = false, // Store confidence/corrected data
        useSmartMapping = true, // Use Gemini to map fields
        sendAsArray = false, // If true, wraps payload in { records, metadata } envelope. Default false: sends the record object directly.
      } = config;

      // Track Gemini token usage
      let geminiTokensUsed = null;

      console.log("=".repeat(60));
      console.log(`[Export] Processing request`);
      console.log(`[Export] Execution: ${executionId}`);
      console.log("-".repeat(60));
      console.log(`[Export] CONFIG:`);
      console.log(`  - targetApiUrl: ${targetApiUrl}`);
      console.log(`  - targetMethod: ${targetMethod}`);
      console.log(`  - custom headers: ${Object.keys(headers).join(", ")}`);
      console.log(`  - includeMetadata: ${includeMetadata}`);
      console.log(`  - smartMapping: ${useSmartMapping}`);
      console.log(
        `  - targetFields count: ${targetFields ? targetFields.length : 0}`,
      );

      // Validate required config
      if (!targetApiUrl) {
        throw new Error("targetApiUrl is required in config");
      }

      // 1. Get data from input
      const inputData = input.data || input;
      if (!inputData || Object.keys(inputData).length === 0) {
        throw new Error("No data provided in input");
      }

      // Convert fieldMapping from array format to object format if needed
      let normalizedFieldMapping = fieldMapping;
      if (Array.isArray(fieldMapping)) {
        normalizedFieldMapping = {};
        for (const item of fieldMapping) {
          if (!item || typeof item !== "object") continue;
          normalizedFieldMapping[item.key || item.columnName] =
            item.value || item.fieldPath;
        }
      }

      // 2. Extract records
      // Note: We don't have "inferredSchema" returning useful SQL types anymore,
      // but we still get a list of records.
      let records = exportService.extractRecords(
        inputData,
        normalizedFieldMapping,
        unmappedFieldStrategy,
        { flattenFieldsMode, includeExtractionMetadata },
      );

      console.log(`[Export] EXTRACTED ${records.length} records`);

      // 3. Smart Mapping
      // Only runs if useSmartMapping is true AND user provided targetFields
      let fieldMappingApplied = null;

      if (
        useSmartMapping &&
        records.length > 0 &&
        targetFields &&
        targetFields.length > 0
      ) {
        // Get incoming field names from first record
        const incomingFields = Object.keys(records[0]).filter(
          (f) => !f.startsWith("_"),
        );

        console.log(`[Export] Attempting Smart Mapping...`);

        // Use Gemini
        const mappingResult = await geminiService.mapFieldsToColumns(
          incomingFields,
          targetFields,
        );

        if (mappingResult.tokensUsed) {
          geminiTokensUsed = mappingResult.tokensUsed;
        }

        if (Object.keys(mappingResult.mapping).length > 0) {
          records = geminiService.applyFieldMapping(
            records,
            mappingResult.mapping,
          );
          fieldMappingApplied = mappingResult.mapping;
          console.log(`[Export] Applied smart field mapping`);
        }
      } else if (
        useSmartMapping &&
        (!targetFields || targetFields.length === 0)
      ) {
        console.log(
          "[Export] Smart Mapping requested but skipped: No 'targetFields' provided in config.",
        );
      }

      // 4. Apply Body Template (if provided)
      // Reconstructs flat records into the nested JSON shape the target API expects.
      if (bodyTemplate && bodyTemplate.length > 0) {
        console.log(
          `[Export] Applying body template with ${bodyTemplate.length} mappings`,
        );
        records = records.map((record) =>
          exportService.buildNestedBody(record, bodyTemplate),
        );
      }

      // 5. Add Metadata (if enabled)
      if (includeMetadata) {
        records = records.map((record) => ({
          ...record,
          _execution_id: executionId,
          _workflow_id: workflowId,
          _created_at: new Date().toISOString(),
        }));
      }

      // 5. Send to Webhook
      // Prepare headers: Merge 'headers' object with 'authHeader' if provided
      const finalHeaders = { ...headers };
      if (authHeader) {
        finalHeaders["Authorization"] = authHeader;
      }

      // Log the final payload being sent
      console.log("[Export] OUTPUT PAYLOAD TO API:");
      console.log(JSON.stringify(records, null, 2));

      const sendResult = await exportService.sendRecords(
        targetApiUrl,
        records,
        {
          method: targetMethod,
          headers: finalHeaders,
          metadata: { executionId, workflowId },
          sendAsArray,
        },
      );

      const processingTime = Date.now() - startTime;

      // Build Response
      res.json({
        success: true,
        data: {
          recordsProcessed: records.length,
          recordsSent: sendResult.recordsSent,
          targetApiUrl,
          fieldMappingApplied,
          outputPayload: records,
        },
        metadata: {
          processingTime,
          serviceVersion: SERVICE_VERSION,
          tokensUsed: geminiTokensUsed ? geminiTokensUsed.totalTokens : 0,
        },
      });
    } catch (error) {
      const processingTime = Date.now() - startTime;
      console.error(`[Export] Error:`, error.message);

      res.status(400).json({
        success: false,
        error: {
          code: "EXPORT_ERROR",
          message: error.message,
        },
        metadata: {
          processingTime,
          serviceVersion: SERVICE_VERSION,
        },
      });
    }
  },
);

// ============================================
// Start Server
// ============================================
app.listen(PORT, () => {
  console.log(`Lekana Export Service (Webhook Mode) running on port ${PORT}`);
  console.log(`Version: ${SERVICE_VERSION}`);
});
