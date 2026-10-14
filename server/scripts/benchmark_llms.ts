import { getDb } from "../db";
import { trelloCachedCards } from "../../drizzle/schema.postgres";
import fs from "fs/promises";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

// The prompt from server/services/atis-understanding.ts
const SYSTEM_PROMPT = `You are an expert task analyst for a Virtual Assistant management system. Your job is to analyze Trello cards and extract structured information to help VAs understand and complete tasks efficiently.

Analyze the provided card information and return a JSON object with the following structure:
{
  "goal": "Clear, concise statement of what this task is trying to achieve (1-2 sentences)",
  "deliverable": "Specific, tangible output that marks this task as complete",
  "taskType": "One of: communication, research, creation, meeting, review, admin, finance, legal, technical, personal",
  "entities": {
    "people": ["Names of people mentioned or involved"],
    "organizations": ["Companies, agencies, institutions mentioned"],
    "cases": ["Case numbers, reference numbers, ticket IDs"],
    "systems": ["Software, platforms, tools mentioned"],
    "documents": ["Specific documents referenced"]
  },
  "deadlines": [{"date": "YYYY-MM-DD", "source": "where this deadline came from", "description": "what's due"}],
  "estimatedMinutes": 30,
  "dependencies": ["What must happen before this task can be completed"],
  "produces": ["What completing this task enables or produces"],
  "domain": "Area of work (e.g., HR, Finance, Legal, IT, Personal, Business)",
  "complexity": "simple|medium|complex",
  "clarityScore": 7,
  "missingInfo": ["Information that would help complete this task but is not provided"],
  "confidenceScore": 85,
  "aptlssChecklist": [
    {"name": "Step 1 description", "estimatedMinutes": 10, "priority": "A"},
    {"name": "Step 2 description", "estimatedMinutes": 15, "priority": "P"}
  ],
  "suggestedTags": ["tag1", "tag2"],
  "isActionable": true,
  "reasonNotActionable": "If false, why?"
}

Return ONLY valid JSON. Do not include markdown formatting or explanation.`;

async function callOpenAI(model: string, apiKey: string, prompt: string, system: string, baseUrl = "https://api.openai.com/v1/chat/completions") {
  const response = await fetch(baseUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt }
      ],
      response_format: { type: "json_object" },
      temperature: 0.1
    })
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`API Error (${model}): ${response.status} - ${err}`);
  }

  const data = await response.json();
  return data.choices[0].message.content;
}

async function callGemini(apiKey: string, prompt: string, system: string) {
  // Using the REST API for Gemini 2.5 Flash
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      systemInstruction: {
        parts: [{ text: system }]
      },
      contents: [{
        parts: [{ text: prompt }]
      }],
      generationConfig: {
        temperature: 0.1,
        responseMimeType: "application/json"
      }
    })
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Gemini API Error: ${response.status} - ${err}`);
  }

  const data = await response.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
}

// Function to automatically score the response
function scoreResponse(jsonString: string): { score: number; notes: string; isValidJson: boolean } {
  let score = 0;
  let notes = [];
  let parsed;
  
  try {
    parsed = JSON.parse(jsonString);
    score += 4; // Valid JSON is crucial
    notes.push("Valid JSON (+4)");
  } catch (e) {
    return { score: 0, notes: "Invalid JSON (Score 0)", isValidJson: false };
  }

  // Check required fields
  if (parsed.goal && typeof parsed.goal === "string" && parsed.goal.length > 5) { score += 1; notes.push("Goal present (+1)"); }
  if (parsed.deliverable && typeof parsed.deliverable === "string" && parsed.deliverable.length > 5) { score += 1; notes.push("Deliverable present (+1)"); }
  if (Array.isArray(parsed.aptlssChecklist) && parsed.aptlssChecklist.length > 0) { 
    score += 2; 
    notes.push("Checklist present (+2)"); 
  }
  if (typeof parsed.isActionable === "boolean") { score += 1; notes.push("Actionability present (+1)"); }
  if (typeof parsed.confidenceScore === "number") { score += 1; notes.push("Confidence score present (+1)"); }

  return { score, notes: notes.join(", "), isValidJson: true };
}

async function runBenchmark() {
  console.log("Starting LLM Benchmark...");
  
  if (!process.env.TRELLO_API_KEY || !process.env.TRELLO_TOKEN) {
    throw new Error("Trello API Key or Token not found in .env");
  }

  console.log("Fetching up to 20 cards directly from Trello...");
  
  const trelloUrl = `https://api.trello.com/1/members/me/cards?key=${process.env.TRELLO_API_KEY}&token=${process.env.TRELLO_TOKEN}&limit=20`;
  const trelloRes = await fetch(trelloUrl);
  if (!trelloRes.ok) {
    throw new Error(`Failed to fetch from Trello: ${trelloRes.statusText}`);
  }
  
  const cards = await trelloRes.json();
  
  if (!cards || cards.length === 0) {
    console.log("No cards found in Trello for this user.");
    process.exit(1);
  }

  console.log(`Found ${cards.length} cards. Beginning benchmark...`);

  const results = [];

  for (let i = 0; i < Math.min(20, cards.length); i++) {
    const cardData = cards[i];
    const cardName = cardData.name || "Unknown Card";
    const cardDesc = cardData.desc || "No description";
    console.log(`\n[${i + 1}/${cards.length}] Processing Card: ${cardName}`);

    const prompt = `Card Name: ${cardName}\nDescription: ${cardDesc}`;

    const cardResult: any = {
      cardName,
      models: {}
    };

    // 1. Gemini 2.5 Flash
    if (process.env.GEMINI_API_KEY) {
      try {
        console.log("  -> Testing Gemini 2.5 Flash...");
        const start = Date.now();
        const res = await callGemini(process.env.GEMINI_API_KEY, prompt, SYSTEM_PROMPT);
        const timeMs = Date.now() - start;
        const scoring = scoreResponse(res);
        cardResult.models["Gemini-2.5-Flash"] = { timeMs, score: scoring.score, notes: scoring.notes, rawLength: res.length };
      } catch (err: any) {
        cardResult.models["Gemini-2.5-Flash"] = { error: err.message };
      }
    }

    // 2. OpenRouter (qwen-2.5-72b-instruct)
    if (process.env.OPENROUTER_API_KEY) {
      try {
        console.log("  -> Testing OpenRouter (qwen-2.5-72b-instruct)...");
        const start = Date.now();
        const res = await callOpenAI("qwen/qwen-2.5-72b-instruct", process.env.OPENROUTER_API_KEY, prompt, SYSTEM_PROMPT, "https://openrouter.ai/api/v1/chat/completions");
        const timeMs = Date.now() - start;
        const scoring = scoreResponse(res);
        cardResult.models["OpenRouter-Qwen-72B"] = { timeMs, score: scoring.score, notes: scoring.notes, rawLength: res.length };
      } catch (err: any) {
        cardResult.models["OpenRouter-Qwen-72B"] = { error: err.message };
      }
    }

    // 3. Groq (llama-3.3-70b-versatile)
    if (process.env.GROQ_API_KEY) {
      try {
        console.log("  -> Testing Groq (llama-3.3-70b)...");
        const start = Date.now();
        const res = await callOpenAI("llama-3.3-70b-versatile", process.env.GROQ_API_KEY, prompt, SYSTEM_PROMPT, "https://api.groq.com/openai/v1/chat/completions");
        const timeMs = Date.now() - start;
        const scoring = scoreResponse(res);
        cardResult.models["Groq-Llama-3.3"] = { timeMs, score: scoring.score, notes: scoring.notes, rawLength: res.length };
      } catch (err: any) {
        cardResult.models["Groq-Llama-3.3"] = { error: err.message };
      }
    }

    // 4. OpenAI (gpt-4o-mini)
    if (process.env.OPENAI_API_KEY) {
      try {
        console.log("  -> Testing OpenAI (gpt-4o-mini)...");
        const start = Date.now();
        const res = await callOpenAI("gpt-4o-mini", process.env.OPENAI_API_KEY, prompt, SYSTEM_PROMPT, "https://api.openai.com/v1/chat/completions");
        const timeMs = Date.now() - start;
        const scoring = scoreResponse(res);
        cardResult.models["OpenAI-GPT4o-Mini"] = { timeMs, score: scoring.score, notes: scoring.notes, rawLength: res.length };
      } catch (err: any) {
        cardResult.models["OpenAI-GPT4o-Mini"] = { error: err.message };
      }
    }

    results.push(cardResult);
  }

  console.log("\nGenerating Markdown Report...");
  let markdown = `# LLM Benchmark Results\n\n`;
  markdown += `Tested ${results.length} cards against Gemini, OpenRouter, Groq, and OpenAI.\n\n`;
  markdown += `| Card Name | Gemini Flash (Score/Time) | OpenRouter Qwen (Score/Time) | Groq Llama3.3 (Score/Time) | OpenAI GPT4o-Mini (Score/Time) |\n`;
  markdown += `|---|---|---|---|---|\n`;

  for (const r of results) {
    const row = [r.cardName.substring(0, 30) + (r.cardName.length > 30 ? "..." : "")];
    
    for (const m of ["Gemini-2.5-Flash", "OpenRouter-Qwen-72B", "Groq-Llama-3.3", "OpenAI-GPT4o-Mini"]) {
      const stats = r.models[m];
      if (stats?.error) {
        row.push(`ERROR`);
      } else if (stats) {
        row.push(`${stats.score}/10 (${stats.timeMs}ms)`);
      } else {
        row.push(`N/A`);
      }
    }
    
    markdown += `| ${row.join(" | ")} |\n`;
  }

  const outPath = path.join(process.cwd(), "benchmark_results.md");
  await fs.writeFile(outPath, markdown);
  console.log(`\nBenchmark Complete! Results saved to: ${outPath}`);
  
  process.exit(0);
}

runBenchmark().catch(err => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
