/**
 * Gemini Service for DB Export
 * Handles intelligent field-to-column mapping using LLM
 */
const { GoogleGenerativeAI } = require("@google/generative-ai");

// Check for API key at startup
if (!process.env.GEMINI_API_KEY) {
  console.warn(
    "[Gemini] WARNING: GEMINI_API_KEY not set - smart field mapping will be disabled",
  );
}

// Initialize Gemini client
const genAI = process.env.GEMINI_API_KEY
  ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
  : null;
const model = genAI
  ? genAI.getGenerativeModel({ model: "gemini-2.0-flash" })
  : null;

/**
 * Map incoming field names to target API fields using Gemini
 * @param {string[]} incomingFields - Field names from OCR result
 * @param {string[]} targetFields - Expected field names in the target API
 * @returns {Promise<{mapping: Record<string, string|null>, tokensUsed: object}>}
 */
async function mapFieldsToColumns(incomingFields, targetFields) {
  // Check if Gemini is available
  if (!model) {
    console.log(
      "[Gemini] Gemini not initialized (missing API key), skipping smart mapping",
    );
    return {
      mapping: {},
      tokensUsed: null,
      skipped: true,
      error: "GEMINI_API_KEY not configured",
    };
  }

  // Filter out internal columns (starting with _)
  const cleanTargetFields = targetFields.filter((col) => !col.startsWith("_"));

  // If no target fields, no mapping needed
  if (cleanTargetFields.length === 0) {
    console.log("[Gemini] No target fields provided, skipping mapping");
    return {
      mapping: {},
      tokensUsed: null,
      skipped: true,
    };
  }

  // If incoming fields match target fields exactly, no Gemini call needed
  const allMatch = incomingFields.every((field) =>
    cleanTargetFields.includes(field) // Case sensitive check first
    || cleanTargetFields.includes(field.toLowerCase())
  );
  if (allMatch) {
    console.log(
      "[Gemini] All fields match target fields, skipping LLM call",
    );
    const directMapping = {};
    incomingFields.forEach((f) => {
      // Find the matching target field (preference to exact match, then case-insensitive)
      const exact = cleanTargetFields.find(t => t === f);
      const insensitive = cleanTargetFields.find(t => t.toLowerCase() === f.toLowerCase());
      directMapping[f] = exact || insensitive || f;
    });
    return {
      mapping: directMapping,
      tokensUsed: null,
      skipped: true,
    };
  }

  const prompt = `You are a data integration expert. Map incoming JSON field names to expected target API fields.

TARGET API FIELDS:
${cleanTargetFields.map((c) => `- ${c}`).join("\n")}

INCOMING FIELD NAMES:
${incomingFields.map((f) => `- ${f}`).join("\n")}

RULES:
1. Match fields based on semantic meaning (e.g., "inv_no" → "invoice_number")
2. If a field has no semantic match, map it to null (it will be unmapped)
3. Each incoming field must map to at most ONE target field
4. Return ONLY valid JSON

OUTPUT FORMAT:
{
  "mapping": {
    "incoming_field_1": "target_field_or_null",
    "incoming_field_2": "target_field_or_null"
  },
  "explanation": ["brief reason for each mapping"]
}`;

  console.log("[Gemini] Mapping fields to target...");
  console.log(`  - Incoming: ${incomingFields.join(", ")}`);
  console.log(`  - Target: ${cleanTargetFields.join(", ")}`);

  try {
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();

    // Extract token usage
    const usageMetadata = response.usageMetadata;
    const tokensUsed = usageMetadata
      ? {
        promptTokens: usageMetadata.promptTokenCount || 0,
        completionTokens: usageMetadata.candidatesTokenCount || 0,
        totalTokens: usageMetadata.totalTokenCount || 0,
      }
      : null;

    if (tokensUsed) {
      console.log(
        `[Gemini] Token usage: ${tokensUsed.promptTokens} prompt + ${tokensUsed.completionTokens} completion = ${tokensUsed.totalTokens} total`,
      );
    }

    // Parse response
    const parsed = cleanAndParseJson(text);
    const mapping = parsed.mapping || {};

    console.log("[Gemini] Field mapping result:");
    for (const [field, target] of Object.entries(mapping)) {
      console.log(`  - ${field} → ${target || "(unmapped)"}`);
    }

    return {
      mapping,
      explanation: parsed.explanation || [],
      tokensUsed,
    };
  } catch (error) {
    console.error("[Gemini] Error mapping fields:", error.message);
    // On error, return empty mapping
    return {
      mapping: {},
      tokensUsed: null,
      error: error.message,
    };
  }
}

/**
 * Apply field mapping to records
 * @param {Record<string, any>[]} records - Records to transform
 * @param {Record<string, string|null>} mapping - Field to column mapping
 * @returns {Record<string, any>[]} Transformed records
 */
function applyFieldMapping(records, mapping) {
  if (!mapping || Object.keys(mapping).length === 0) {
    return records;
  }

  return records.map((record) => {
    const mappedRecord = {};
    const extraData = {};

    for (const [field, value] of Object.entries(record)) {
      // Skip internal fields
      if (field.startsWith("_")) {
        mappedRecord[field] = value;
        continue;
      }

      const mappedTarget = mapping[field];

      if (mappedTarget) {
        // Field has a mapping - use the mapped target name
        mappedRecord[mappedTarget] = value;
      } else if (mappedTarget === null) {
        // Explicitly unmapped - store in extra data
        extraData[field] = value;
      } else {
        // No mapping exists for this field - keep original name
        mappedRecord[field] = value;
      }
    }

    // Store unmapped fields in _extra_data
    if (Object.keys(extraData).length > 0) {
      mappedRecord._extra_data = {
        ...(mappedRecord._extra_data || {}),
        ...extraData,
      };
    }

    return mappedRecord;
  });
}

/**
 * Clean and parse JSON from Gemini response
 * @param {string} text - Raw Gemini response
 * @returns {Object} Parsed JSON
 */
function cleanAndParseJson(text) {
  // Remove markdown code fences
  let cleaned = text
    .replace(/```json\n?/gi, "")
    .replace(/```\n?/gi, "")
    .trim();

  // Try to find JSON object
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    cleaned = jsonMatch[0];
  }

  try {
    return JSON.parse(cleaned);
  } catch (error) {
    console.error("[Gemini] Failed to parse JSON:", error.message);
    return { mapping: {} };
  }
}

module.exports = {
  mapFieldsToColumns, // Keeping name for compatibility, but logic is changed
  applyFieldMapping,
};
