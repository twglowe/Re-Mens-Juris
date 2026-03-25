/* EX LIBRIS JURIS v3.4.2 — diagram.js
   Entity Relationship Diagram endpoint.
   Takes Dramatis Personae text, calls Claude to extract structured
   entity/relationship JSON, returns it for frontend rendering.

   POST /api/diagram
   Body: { personsText: "...", matterName: "...", jurisdiction: "..." }
   Returns: { entities: [...], relationships: [...] }
*/

import { createClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";

export const config = { maxDuration: 120 };

var supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
var anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

var INPUT_COST_PER_M = 3.00;
var OUTPUT_COST_PER_M = 15.00;

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  /* Auth check */
  var authHeader = req.headers.authorization || "";
  var token = authHeader.replace("Bearer ", "").trim();
  if (!token) return res.status(401).json({ error: "No token" });

  var userResp = await supabase.auth.getUser(token);
  if (userResp.error || !userResp.data || !userResp.data.user) {
    return res.status(401).json({ error: "Invalid token" });
  }
  var userId = userResp.data.user.id;

  var body = req.body || {};
  var personsText = body.personsText || "";
  var matterName = body.matterName || "Matter";
  var matterId = body.matterId || null;
  var jurisdiction = body.jurisdiction || "Bermuda";

  if (!personsText || personsText.length < 50) {
    return res.status(400).json({ error: "Dramatis Personae text is too short to analyse" });
  }

  /* Truncate if very long */
  if (personsText.length > 60000) {
    personsText = personsText.slice(0, 60000) + "\n[...truncated...]";
  }

  try {
    var response = await anthropic.messages.create({
      model: process.env.CLAUDE_MODEL || "claude-sonnet-4-6",
      max_tokens: 4096,
      system: "You are a legal analyst extracting entity relationships from a dramatis personae document for the matter \"" + matterName + "\" in " + jurisdiction + ".\n\nReturn ONLY valid JSON with no preamble, no markdown backticks, no explanation. The JSON must have this exact structure:\n{\n  \"entities\": [\n    {\n      \"id\": \"e1\",\n      \"name\": \"Full Name or Entity Name\",\n      \"type\": \"person\" | \"company\" | \"trust\" | \"fund\" | \"government\" | \"other\",\n      \"description\": \"Brief role description\"\n    }\n  ],\n  \"relationships\": [\n    {\n      \"source\": \"e1\",\n      \"target\": \"e2\",\n      \"type\": \"director\" | \"shareholder\" | \"beneficiary\" | \"trustee\" | \"manager\" | \"officer\" | \"creditor\" | \"debtor\" | \"spouse\" | \"parent_child\" | \"employer\" | \"subsidiary\" | \"advisor\" | \"agent\" | \"partner\" | \"guarantor\" | \"other\",\n      \"label\": \"Short description of the relationship\"\n    }\n  ]\n}\n\nRules:\n1. Include ALL persons and entities from the dramatis personae.\n2. Identify ALL relationships between them — directorship, shareholding, beneficial ownership, trusteeship, management, creditor/debtor, family, employment, subsidiary/parent, agency, and any other connections.\n3. If a relationship type does not fit the listed types, use \"other\" and provide a clear label.\n4. Each entity must have a unique id (e1, e2, e3, etc.).\n5. Use the source/target ids to define relationships.\n6. Do NOT include attorneys, counsel, solicitors, barristers, judges, masters, or registrars.\n7. Return ONLY the JSON object. No other text.",
      messages: [{ role: "user", content: "Extract all entities and their relationships from this Dramatis Personae:\n\n" + personsText }],
    });

    var text = "";
    if (response.content) {
      for (var i = 0; i < response.content.length; i++) {
        if (response.content[i].type === "text") { text = response.content[i].text; break; }
      }
    }

    var inputTokens = (response.usage && response.usage.input_tokens) || 0;
    var outputTokens = (response.usage && response.usage.output_tokens) || 0;
    var cost = (inputTokens * INPUT_COST_PER_M / 1000000) + (outputTokens * OUTPUT_COST_PER_M / 1000000);

    /* Parse the JSON response */
    var cleaned = text.replace(/```json|```/g, "").trim();
    var startIdx = cleaned.indexOf("{");
    var endIdx = cleaned.lastIndexOf("}");
    if (startIdx === -1 || endIdx === -1) {
      return res.status(500).json({ error: "Failed to extract structured data from Claude response" });
    }
    var jsonStr = cleaned.slice(startIdx, endIdx + 1);
    var data;
    try {
      data = JSON.parse(jsonStr);
    } catch (parseErr) {
      console.error("JSON parse error:", parseErr.message, "Raw:", jsonStr.slice(0, 200));
      return res.status(500).json({ error: "Failed to parse entity data" });
    }

    /* Validate structure */
    if (!data.entities || !Array.isArray(data.entities)) {
      return res.status(500).json({ error: "Invalid entity data structure" });
    }
    if (!data.relationships) data.relationships = [];

    /* Log usage */
    if (matterId) {
      try {
        await supabase.from("usage_log").insert({
          matter_id: matterId, user_id: userId, tool_name: "diagram",
          input_tokens: inputTokens, output_tokens: outputTokens, cost_usd: cost,
        });
      } catch (e) { console.error("Usage log error:", e); }
    }

    return res.status(200).json({
      entities: data.entities,
      relationships: data.relationships,
      usage: { inputTokens: inputTokens, outputTokens: outputTokens, costUsd: cost },
    });

  } catch (err) {
    console.error("Diagram endpoint error:", err);
    return res.status(500).json({ error: err.message || "Diagram generation failed" });
  }
}
