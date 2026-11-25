import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { server } from "./server.mjs";

let baseUrl;

before(async () => {
  // Port 0 = any free port.
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

async function triage(body) {
  const response = await fetch(`${baseUrl}/api/triage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  return { status: response.status, body: await response.json() };
}

const manualReview = { status: "manual_review", topic: null, draft: null };

test("normal request returns topic and draft", async () => {
  const { status, body } = await triage(
    JSON.stringify({ text: "Когда будет доставка?" }),
  );
  assert.equal(status, 200);
  assert.equal(body.status, "ready");
  assert.equal(body.topic, "delivery");
  assert.ok(body.draft.trim().length > 0);
});

test("model timeout returns manual_review within the time limit", async () => {
  const started = Date.now();
  const { status, body } = await triage(
    JSON.stringify({ text: "Привет [timeout]" }),
  );
  assert.equal(status, 200);
  assert.deepEqual(body, manualReview);
  // The mock waits 1200 ms; we must give up after about 300 ms.
  assert.ok(Date.now() - started < 800, "server waited for the model too long");
});

for (const tag of ["[error]", "[bad-json]", "[bad-topic]", "[empty-draft]"]) {
  test(`model failure ${tag} returns manual_review`, async () => {
    const { status, body } = await triage(
      JSON.stringify({ text: `Привет ${tag}` }),
    );
    assert.equal(status, 200);
    assert.deepEqual(body, manualReview);
  });
}

const invalidBodies = {
  "broken JSON": "{not json",
  "missing text": "{}",
  "empty text": JSON.stringify({ text: "" }),
  "whitespace text": JSON.stringify({ text: "   " }),
  "number text": JSON.stringify({ text: 42 }),
  "null body": "null",
};

for (const [name, body] of Object.entries(invalidBodies)) {
  test(`${name} returns invalid_input`, async () => {
    const response = await triage(body);
    assert.equal(response.status, 400);
    assert.deepEqual(response.body, { status: "invalid_input" });
  });
}
