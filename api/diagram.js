/* EX LIBRIS JURIS v3.6 — diagram.js
   Entity Relationship Diagram endpoint.
   Takes Dramatis Personae text, calls Claude to extract structured
   entity/relationship JSON, returns it for frontend rendering.

   POST /api/diagram
   Body: { personsText, matterName, matterId, jurisdiction, focusEntities, filterTypes }
   Returns: { entities: [...], relationships: [...], usage: {...} }

   v3.5: Added focusEntities parameter
   v3.6: Added filterTypes parameter — when provided, instructs Claude
   to only extract relationships of the specified types. */

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
  var focusEntities = body.focusEntities || [];
  var filterTypes = body.filterTypes || [];

  if (!personsText || personsText.length < 50) {
    return res.status(400).json({ error: "Dramatis Personae text is too short to analyse" });
  }

  /* Truncate if very long */
  if (personsText.length > 60000) {
    personsText = personsText.slice(0, 60000) + "\n[...truncated...]";
  }

  var systemPrompt = "You are a legal analyst extracting entity relationship data from a Dramatis Personae document for the matter \"" + matterName + "\" in " + jurisdiction + ".\n\n"
    + "You MUST respond with ONLY a valid JSON object — no markdown, no backticks, no preamble, no explanation.\n\n"
    + "Extract every person and entity mentioned and identify all relationships between them.\n\n"
    + "JSON format:\n"
    + "{\n"
    + "  \"entities\": [\n"
    + "    { \"id\": \"e1\", \"name\": \"Full Name\", \"type\": \"person|company|trust|fund|government|partnership|other\", \"description\": \"Brief role description\" }\n"
    + "  ],\n"
    + "  \"relationships\": [\n"
    + "    { \"source\": \"e1\", \"target\": \"e2\", \"type\": \"TYPE\", \"label\": \"Short description\" }\n"
    + "  ]\n"
    + "}\n\n"
    + "Relationship types (use the most specific that fits):\n"
    + "- director — director of a company\n"
    + "- shareholder — direct shareholder (include percentage if known, e.g. \"51% shareholder\")\n"
    + "- indirect_shareholder — indirect or ultimate shareholder through intermediate entities\n"
    + "- ultimate_beneficial_owner — ultimate beneficial owner of an entity\n"
    + "- limited_partner — limited partner in a partnership or fund\n"
    + "- general_partner — general partner in a partnership or fund\n"
    + "- beneficiary — beneficiary of a trust\n"
    + "- trustee — trustee of a trust\n"
    + "- protector — protector of a trust\n"
    + "- enforcer — enforcer of a trust or purpose trust\n"
    + "- settlor — settlor or founder of a trust\n"
    + "- nominee — nominee holder (shares, property, etc.)\n"
    + "- registered_agent — registered agent or registered office provider\n"
    + "- manager — manager of a company or fund\n"
    + "- officer — officer (secretary, treasurer, etc.)\n"
    + "- creditor — creditor\n"
    + "- debtor — debtor\n"
    + "- guarantor — guarantor\n"
    + "- subsidiary — parent/subsidiary corporate relationship\n"
    + "- employer — employment relationship\n"
    + "- advisor — advisor, consultant, or professional service provider\n"
    + "- agent — agent or representative\n"
    + "- partner — business partner (not limited/general partner)\n"
    + "- spouse — spouse or domestic partner\n"
    + "- parent_child — parent/child or family relationship\n"
    + "- other — any other connection (provide a clear label)\n\n"
    + "Rules:\n"
    + "- Every entity MUST have a unique id (e1, e2, e3, ...)\n"
    + "- The label should be concise (2-5 words), e.g. \"Director of\", \"51% shareholder\", \"Trustee of\", \"UBO via Fund A\"\n"
    + "- Include ALL entities and ALL relationships you can identify\n"
    + "- source and target must reference valid entity ids\n"
    + "- For directional relationships, source is the person/entity that holds the role (e.g. the director, the shareholder, the creditor)\n"
    + "- If two entities share a common director or officer, create a relationship from that person to each entity\n"
    + "- If A owns B which owns C, show BOTH the direct relationship (A→B) AND the indirect relationship (A→C as indirect_shareholder)\n"
    + "- Do NOT include attorneys, counsel, solicitors, barristers, judges, masters, or registrars\n"
    + "- Respond with ONLY the JSON object";

  /* If focus entities are specified, add focus instruction */
  if (focusEntities.length > 0) {
    systemPrompt += "\n\nIMPORTANT — FOCUS MODE: Focus on these entities: " + focusEntities.join(", ") + ". "
      + "Include only entities that are directly or indirectly connected to any of these focal entities through any chain of relationships. "
      + "Always include the focal entities themselves. "
      + "Include all relationships between the returned entities. "
      + "Still follow all other rules above.";
  }

  /* Stage 3b: If filterTypes are specified, restrict relationship extraction */
  if (filterTypes.length > 0) {
    systemPrompt += "\n\nIMPORTANT — RELATIONSHIP FILTER: Only extract relationships of these types: " + filterTypes.join(", ") + ". "
      + "Do not include any other relationship types. "
      + "Still include all entities, even if they have no relationships of the specified types.";
  }

  try {
    var response = await anthropic.messages.create({
      model: process.env.CLAUDE_MODEL || "claude-sonnet-4-6",
      max_tokens: 8192,
      system: systemPrompt,
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

    /* Parse the JSON response — robust extraction */
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
      console.error("JSON parse error:", parseErr.message, "Raw:", jsonStr.slice(0, 300));
      return res.status(500).json({ error: "Failed to parse entity data" });
    }

    /* Validate structure */
    if (!data.entities || !Array.isArray(data.entities)) {
      return res.status(500).json({ error: "Invalid entity data structure" });
    }
    if (!data.relationships) data.relationships = [];

    /* Build set of valid entity ids and filter invalid relationships */
    var validIds = {};
    for (var ei = 0; ei < data.entities.length; ei++) {
      validIds[data.entities[ei].id] = true;
    }
    data.relationships = data.relationships.filter(function(rel) {
      return validIds[rel.source] && validIds[rel.target];
    });

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
