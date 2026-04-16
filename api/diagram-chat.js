/* EX LIBRIS JURIS v3.6 — diagram-chat.js
   Follow-up chat endpoint for the entity relationship diagram.
   Accepts a question/instruction plus the current diagram state,
   returns updated entities/relationships plus an explanation.

   POST /api/diagram-chat
   Body: { question, currentEntities, currentRelationships, matterName, jurisdiction, personsText }
   Returns: { entities: [...], relationships: [...], explanation: "...", usage: {...} } */

import { createClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";

export const config = { maxDuration: 120 };

var supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
var anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

var INPUT_COST_PER_M = 3.00;
var OUTPUT_COST_PER_M = 15.00;

const SERVER_VERSION = "v5.5";
export default async function handler(req, res) {
  console.log(SERVER_VERSION + " diagram-chat handler: " + (req.method || "?") + " " + (req.url || ""));
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
  var question = body.question || "";
  var currentEntities = body.currentEntities || [];
  var currentRelationships = body.currentRelationships || [];
  var matterName = body.matterName || "Matter";
  var jurisdiction = body.jurisdiction || "Bermuda";
  var personsText = body.personsText || "";

  if (!question) {
    return res.status(400).json({ error: "No question provided" });
  }

  /* Build the current diagram state as JSON for the prompt */
  var currentDiagram = JSON.stringify({
    entities: currentEntities,
    relationships: currentRelationships
  });

  var systemPrompt = "You are a legal analyst managing an entity relationship diagram for the matter \"" + matterName + "\" in " + jurisdiction + ".\n\n"
    + "You have an existing diagram with entities and relationships. The user is asking a question or giving an instruction about the diagram.\n\n"
    + "You MUST respond with ONLY a valid JSON object — no markdown, no backticks, no preamble.\n\n"
    + "JSON format:\n"
    + "{\n"
    + "  \"entities\": [ { \"id\": \"e1\", \"name\": \"Full Name\", \"type\": \"person|company|trust|fund|government|partnership|other\", \"description\": \"Brief role\" } ],\n"
    + "  \"relationships\": [ { \"source\": \"e1\", \"target\": \"e2\", \"type\": \"TYPE\", \"label\": \"Short description\" } ],\n"
    + "  \"explanation\": \"A brief explanation of what you changed and why, or an answer to the user's question.\"\n"
    + "}\n\n"
    + "Rules:\n"
    + "- ALWAYS return the full updated entities and relationships arrays — not just the changes\n"
    + "- Keep entity IDs stable: if an entity already exists, keep its same ID\n"
    + "- When adding new entities, use IDs that don't conflict with existing ones (e.g. e100, e101, ...)\n"
    + "- The explanation field should be a natural language response to the user\n"
    + "- If the user asks a question (not an instruction), return the current entities and relationships unchanged, and answer in the explanation field\n"
    + "- If the user asks to add entities or relationships, you can reference the original Dramatis Personae text below to find entities not yet in the diagram\n"
    + "- If the user asks to remove or filter entities, remove them from the arrays\n"
    + "- Valid relationship types: director, shareholder, indirect_shareholder, ultimate_beneficial_owner, limited_partner, general_partner, beneficiary, trustee, protector, enforcer, settlor, nominee, registered_agent, manager, officer, creditor, debtor, guarantor, subsidiary, employer, advisor, agent, partner, spouse, parent_child, other\n"
    + "- Do NOT include attorneys, counsel, solicitors, barristers, judges, masters, or registrars\n"
    + "- Respond with ONLY the JSON object";

  var userContent = "CURRENT DIAGRAM:\n" + currentDiagram + "\n\n";
  if (personsText) {
    userContent += "ORIGINAL DRAMATIS PERSONAE (source material — you can add entities from here that are not yet in the diagram):\n" + personsText + "\n\n";
  }
  userContent += "USER INSTRUCTION:\n" + question;

  try {
    var response = await anthropic.messages.create({
      model: process.env.CLAUDE_MODEL || "claude-sonnet-4-6",
      max_tokens: 8192,
      system: systemPrompt,
      messages: [{ role: "user", content: userContent }],
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
      return res.status(500).json({ error: "Failed to parse diagram update response", explanation: text });
    }
    var jsonStr = cleaned.slice(startIdx, endIdx + 1);
    var data;
    try {
      data = JSON.parse(jsonStr);
    } catch (parseErr) {
      console.error("JSON parse error:", parseErr.message, "Raw:", jsonStr.slice(0, 300));
      return res.status(500).json({ error: "Failed to parse diagram update", explanation: text });
    }

    /* Validate and clean */
    if (!data.entities || !Array.isArray(data.entities)) {
      data.entities = currentEntities;
    }
    if (!data.relationships) data.relationships = [];

    var validIds = {};
    for (var ei = 0; ei < data.entities.length; ei++) {
      validIds[data.entities[ei].id] = true;
    }
    data.relationships = data.relationships.filter(function(rel) {
      return validIds[rel.source] && validIds[rel.target];
    });

    /* Log usage */
    try {
      await supabase.from("usage_log").insert({
        matter_id: null, user_id: userId, tool_name: "diagram-chat",
        input_tokens: inputTokens, output_tokens: outputTokens, cost_usd: cost,
      });
    } catch (e) { console.error("Usage log error:", e); }

    return res.status(200).json({
      entities: data.entities,
      relationships: data.relationships,
      explanation: data.explanation || "Diagram updated.",
      usage: { inputTokens: inputTokens, outputTokens: outputTokens, costUsd: cost },
    });

  } catch (err) {
    console.error("Diagram chat error:", err);
    return res.status(500).json({ error: err.message || "Diagram chat failed" });
  }
}
