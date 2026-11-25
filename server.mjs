import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { classify } from "./mock-ai.mjs";

const html = await readFile(new URL("./index.html", import.meta.url));

const MODEL_TIMEOUT_MS = 300;
const TOPICS = ["delivery", "pricing", "other"];
const MANUAL_REVIEW = { status: "manual_review", topic: null, draft: null };

function json(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}

// Returns the request text, or null if the body is not {"text": "<non-empty string>"}.
async function readText(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
  const text = body?.text;
  if (typeof text !== "string" || text.trim() === "") return null;
  return text;
}

// Calls the model, but gives up after MODEL_TIMEOUT_MS even if the model ignores the signal.
async function askModel(text) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS);
  const timeout = new Promise((_, reject) => {
    controller.signal.addEventListener("abort", () =>
      reject(new Error("Model timeout")),
    );
  });
  try {
    return await Promise.race([
      classify(text, { signal: controller.signal }),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// This is where the AI result is checked. Returns {topic, draft}, or null if the output is unusable.
function parseModelOutput(output) {
  let result;
  try {
    result = JSON.parse(output);
  } catch {
    return null;
  }
  if (!TOPICS.includes(result?.topic)) return null;
  if (typeof result.draft !== "string" || result.draft.trim() === "")
    return null;
  return { topic: result.topic, draft: result.draft };
}

async function handleTriage(request, response) {
  const text = await readText(request);
  if (text === null) return json(response, 400, { status: "invalid_input" });

  let output;
  try {
    output = await askModel(text);
  } catch {
    // Timeout or model error.
    return json(response, 200, MANUAL_REVIEW);
  }

  const result = parseModelOutput(output);
  if (result === null) return json(response, 200, MANUAL_REVIEW);
  return json(response, 200, { status: "ready", ...result });
}

export const server = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/") {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(html);
    return;
  }
  if (request.method !== "POST" || request.url !== "/api/triage") {
    return json(response, 404, { status: "not_found" });
  }
  try {
    await handleTriage(request, response);
  } catch {
    json(response, 500, { status: "server_error" });
  }
});

// Listen only when started with `node server.mjs`, not when imported by the tests.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(Number(process.env.PORT || 3000), "127.0.0.1");
}
