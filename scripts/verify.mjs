import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import handler from "../api/proxy.js";
import { rewriteEdgeOneProxyUrl } from "../api/edgeone.js";
import { setKvDriver } from "../api/kv.js";
import { onRequest as edgeOneV1 } from "../cloud-functions/v1/[[default]].js";
import { rewriteUrl as rewriteDockerUrl } from "../server.js";

const envKeys = [
  "CLIPROXY_API_KEY",
  "CLIPROXY_MODELS",
  "VSCODEPROXY_API_KEY",
  "VSCODEPROXY_MODELS",
  "DEEPSEEK_API_KEY",
  "KIMI_API_KEY",
  "MINIMAX_API_KEY",
  "AZURE_FOUNDRY_API_KEY",
  "AZURE_FOUNDRY_RESOURCE",
  "AZURE_OPENAI_ENDPOINT",
  "AZURE_OPENAI_API_VERSION",
  "AZURE_ANTHROPIC_ENDPOINT",
  "REDIS_URL",
  "KV_URL",
  "KV_TOKEN",
];

const kv = new Map();
setKvDriver({
  async get(key) {
    return kv.get(key) ?? null;
  },
  async set(key, value) {
    kv.set(key, String(value));
  },
});

function resetEnv() {
  for (const key of envKeys) delete process.env[key];
  kv.clear();
}

function jsonRequest(url, body, headers = {}) {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function readJson(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (err) {
    err.message += `; body=${text}`;
    throw err;
  }
}

function mockChatCompletionFetch(assertBody) {
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    assertBody(String(url), body, init);
    return new Response(JSON.stringify({
      id: "chatcmpl_test",
      object: "chat.completion",
      model: body.model,
      choices: [{
        index: 0,
        message: { role: "assistant", content: "hello from chat" },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

async function testModelDiscoveryAndAuth() {
  resetEnv();
  process.env.CLIPROXY_MODELS = "cliproxy/deepseek-v4-pro,vscodeproxy/kimi-k2.6,azure/gpt-5.5,cursorproxy/old";

  let res = await handler(new Request("https://local/v1/models", { method: "GET" }));
  assert.equal(res.status, 200);
  let body = await readJson(res);
  const ids = body.data.map((model) => model.id);
  assert.deepEqual(ids, [
    "deepseek-v4-pro",
    "cliproxy/deepseek-v4-pro",
    "kimi-k2.6",
    "cliproxy/kimi-k2.6",
    "gpt-5.5",
    "cliproxy/gpt-5.5",
  ]);
  assert.equal(body.data[0].owned_by, "cliProxy");

  process.env.CLIPROXY_API_KEY = "secret";
  res = await handler(new Request("https://local/v1/models", { method: "GET" }));
  assert.equal(res.status, 401);

  res = await handler(new Request("https://local/v1/models", {
    method: "GET",
    headers: { authorization: "Bearer secret" },
  }));
  assert.equal(res.status, 200);
}

async function testResponsesBridgeNonStreamingAndState() {
  resetEnv();
  process.env.DEEPSEEK_API_KEY = "upstream";
  const capturedBodies = [];
  mockChatCompletionFetch((url, body) => {
    assert.equal(url, "https://api.deepseek.com/v1/chat/completions");
    capturedBodies.push(body);
  });

  let res = await handler(jsonRequest("https://local/api/proxy?path=responses", {
    model: "cliproxy/deepseek-v4-pro",
    input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
    max_output_tokens: 64,
  }));
  assert.equal(res.status, 200);
  let body = await readJson(res);
  assert.equal(body.object, "response");
  assert.equal(body.model, "cliproxy/deepseek-v4-pro");
  assert.equal(body.output[0].content[0].text, "hello from chat");
  assert.equal(capturedBodies[0].max_tokens, 64);
  assert.equal(capturedBodies[0].messages.at(-1).content, "hi");

  res = await handler(jsonRequest("https://local/api/proxy?path=responses", {
    model: "deepseek-v4-pro",
    previous_response_id: body.id,
    input: "again",
  }));
  assert.equal(res.status, 200);
  body = await readJson(res);
  assert.equal(body.object, "response");
  assert.equal(capturedBodies[1].messages.length, 3);
  assert.equal(capturedBodies[1].messages[0].content, "hi");
  assert.equal(capturedBodies[1].messages[1].role, "assistant");
  assert.equal(capturedBodies[1].messages[2].content, "again");
}

async function testResponsesBridgeStreaming() {
  resetEnv();
  process.env.DEEPSEEK_API_KEY = "upstream";
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(String(url), "https://api.deepseek.com/v1/chat/completions");
    assert.equal(body.stream, true);
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(
          "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\",\"content\":\"hel\"}}]}\n\n" +
          "data: {\"choices\":[{\"delta\":{\"content\":\"lo\"},\"finish_reason\":\"stop\"}]}\n\n" +
          "data: [DONE]\n\n"
        ));
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };

  const res = await handler(jsonRequest("https://local/api/proxy?path=responses", {
    model: "deepseek-v4-pro",
    input: "hi",
    stream: true,
  }));
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /event: response\.created/);
  assert.match(text, /event: response\.output_text\.delta/);
  assert.match(text, /"delta":"hel"/);
  assert.match(text, /event: response\.completed/);
  assert.match(text, /data: \[DONE\]/);
}

async function testResponsesBridgeRepairsMissingToolOutput() {
  resetEnv();
  process.env.DEEPSEEK_API_KEY = "upstream";
  let capturedBody = null;
  mockChatCompletionFetch((url, body) => {
    assert.equal(url, "https://api.deepseek.com/v1/chat/completions");
    capturedBody = body;
  });

  const res = await handler(jsonRequest("https://local/api/proxy?path=responses", {
    model: "deepseek-v4-pro",
    input: [
      { role: "user", content: [{ type: "input_text", text: "test tools" }] },
      {
        type: "function_call",
        call_id: "call_missing",
        name: "search_web",
        arguments: "{\"query\":\"latest\"}",
      },
      {
        role: "assistant",
        content: [{ type: "output_text", text: "continuing after an unsupported tool" }],
      },
      { role: "user", content: [{ type: "input_text", text: "continue" }] },
    ],
    tools: [{ type: "function", name: "search_web", parameters: { type: "object" } }],
  }));
  assert.equal(res.status, 200);

  const assistantIdx = capturedBody.messages.findIndex((msg) =>
    msg.role === "assistant" && msg.tool_calls?.[0]?.id === "call_missing"
  );
  assert.notEqual(assistantIdx, -1);
  assert.equal(capturedBody.messages[assistantIdx + 1].role, "tool");
  assert.equal(capturedBody.messages[assistantIdx + 1].tool_call_id, "call_missing");
  assert.match(capturedBody.messages[assistantIdx + 1].content, /not present/);
  assert.equal(capturedBody.messages[assistantIdx + 2].role, "assistant");
}

async function testResponsesBridgeMovesDelayedToolOutput() {
  resetEnv();
  process.env.DEEPSEEK_API_KEY = "upstream";
  let capturedBody = null;
  mockChatCompletionFetch((url, body) => {
    assert.equal(url, "https://api.deepseek.com/v1/chat/completions");
    capturedBody = body;
  });

  const res = await handler(jsonRequest("https://local/api/proxy?path=responses", {
    model: "deepseek-v4-pro",
    input: [
      { role: "user", content: "test delayed tool output" },
      {
        type: "function_call",
        call_id: "call_delayed",
        name: "local_shell",
        arguments: "{}",
      },
      { role: "assistant", content: "tool output arrived after assistant text" },
      { type: "function_call_output", call_id: "call_delayed", output: "delayed ok" },
      { role: "user", content: "continue" },
    ],
  }));
  assert.equal(res.status, 200);

  const assistantIdx = capturedBody.messages.findIndex((msg) =>
    msg.role === "assistant" && msg.tool_calls?.[0]?.id === "call_delayed"
  );
  assert.notEqual(assistantIdx, -1);
  assert.equal(capturedBody.messages[assistantIdx + 1].role, "tool");
  assert.equal(capturedBody.messages[assistantIdx + 1].content, "delayed ok");
  assert.equal(capturedBody.messages[assistantIdx + 2].content, "tool output arrived after assistant text");
}

async function testResponsesBridgeSkipsUnsupportedBuiltInTools() {
  resetEnv();
  process.env.DEEPSEEK_API_KEY = "upstream";
  let capturedBody = null;
  mockChatCompletionFetch((url, body) => {
    assert.equal(url, "https://api.deepseek.com/v1/chat/completions");
    capturedBody = body;
  });

  const res = await handler(jsonRequest("https://local/api/proxy?path=responses", {
    model: "deepseek-v4-pro",
    input: "hi",
    tools: [{ type: "web_search_preview" }],
  }));
  assert.equal(res.status, 200);
  assert.equal("tools" in capturedBody, false);
}

async function testAzureResponsesStaysNative() {
  resetEnv();
  process.env.AZURE_FOUNDRY_API_KEY = "azure-key";
  process.env.AZURE_FOUNDRY_RESOURCE = "example";
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    assert.match(String(url), /^https:\/\/example\.cognitiveservices\.azure\.com\/openai\/responses\?api-version=/);
    assert.equal(body.model, "gpt-5.5");
    assert.equal(body.input, "hi");
    return new Response(JSON.stringify({
      id: "resp_azure",
      object: "response",
      status: "completed",
      model: body.model,
      output: [{
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "native azure" }],
      }],
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const res = await handler(jsonRequest("https://local/api/proxy?path=responses", {
    model: "gpt-5.5",
    input: "hi",
  }));
  assert.equal(res.status, 200);
  const body = await readJson(res);
  assert.equal(body.id, "resp_azure");
  assert.equal(body.output[0].content[0].text, "native azure");
}

async function testAzureChatResponseFormatMapping() {
  resetEnv();
  process.env.AZURE_FOUNDRY_API_KEY = "azure-key";
  process.env.AZURE_FOUNDRY_RESOURCE = "example";
  const capturedBodies = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    assert.match(String(url), /^https:\/\/example\.cognitiveservices\.azure\.com\/openai\/responses\?api-version=/);
    capturedBodies.push(body);
    return new Response(JSON.stringify({
      id: "resp_format_test",
      object: "response",
      status: "completed",
      model: body.model,
      output: [{
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "formatted" }],
      }],
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  let res = await handler(jsonRequest("https://local/api/proxy?path=chat/completions", {
    model: "gpt-4.1",
    messages: [{ role: "user", content: "json please" }],
    response_format: { type: "json_object" },
  }));
  assert.equal(res.status, 200);
  assert.deepEqual(capturedBodies[0].text.format, { type: "json_object" });
  assert.equal("response_format" in capturedBodies[0], false);

  res = await handler(jsonRequest("https://local/api/proxy?path=chat/completions", {
    model: "gpt-4.1",
    messages: [{ role: "user", content: "schema please" }],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "answer",
        description: "answer payload",
        schema: {
          type: "object",
          properties: { answer: { type: "string" } },
          required: ["answer"],
          additionalProperties: false,
        },
        strict: true,
      },
    },
  }));
  assert.equal(res.status, 200);
  assert.deepEqual(capturedBodies[1].text.format, {
    type: "json_schema",
    name: "answer",
    description: "answer payload",
    schema: {
      type: "object",
      properties: { answer: { type: "string" } },
      required: ["answer"],
      additionalProperties: false,
    },
    strict: true,
  });

  res = await handler(jsonRequest("https://local/api/proxy?path=chat/completions", {
    model: "gpt-4.1",
    messages: [{ role: "user", content: "text wins" }],
    text: { format: { type: "text" }, verbosity: "low" },
    response_format: { type: "json_object" },
  }));
  assert.equal(res.status, 200);
  assert.deepEqual(capturedBodies[2].text, { format: { type: "text" }, verbosity: "low" });
  assert.equal("response_format" in capturedBodies[2], false);
}

async function testAnthropicResponsesBridgeNonStreaming() {
  resetEnv();
  process.env.AZURE_FOUNDRY_API_KEY = "azure-key";
  process.env.AZURE_FOUNDRY_RESOURCE = "example";
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(String(url), "https://example.services.ai.azure.com/anthropic/v1/messages");
    assert.equal(body.model, "claude-sonnet-4-6");
    assert.equal(body.messages.at(-1).content, "hi claude");
    return new Response(JSON.stringify({
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: body.model,
      content: [{ type: "text", text: "hello from claude" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 5, output_tokens: 6 },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const res = await handler(jsonRequest("https://local/api/proxy?path=responses", {
    model: "cliproxy/claude-sonnet-4-6",
    input: "hi claude",
  }));
  assert.equal(res.status, 200);
  const body = await readJson(res);
  assert.equal(body.object, "response");
  assert.equal(body.model, "cliproxy/claude-sonnet-4-6");
  assert.equal(body.output[0].content[0].text, "hello from claude");
}

async function testResponsesBridgeParameterForwarding() {
  resetEnv();
  process.env.DEEPSEEK_API_KEY = "upstream";
  let capturedBody = null;
  mockChatCompletionFetch((url, body) => {
    assert.equal(url, "https://api.deepseek.com/v1/chat/completions");
    capturedBody = body;
  });

  const res = await handler(jsonRequest("https://local/api/proxy?path=responses", {
    model: "deepseek-v4-pro",
    input: "hi",
    stop: ["END"],
    seed: 42,
    frequency_penalty: 0.5,
    presence_penalty: 0.25,
  }));
  assert.equal(res.status, 200);
  assert.deepEqual(capturedBody.stop, ["END"]);
  assert.equal(capturedBody.seed, 42);
  assert.equal(capturedBody.frequency_penalty, 0.5);
  assert.equal(capturedBody.presence_penalty, 0.25);
}

async function testResponsesBridgeAnthropicStopMapping() {
  resetEnv();
  process.env.AZURE_FOUNDRY_API_KEY = "azure-key";
  process.env.AZURE_FOUNDRY_RESOURCE = "example";
  let capturedBody = null;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(String(url), "https://example.services.ai.azure.com/anthropic/v1/messages");
    capturedBody = body;
    return new Response(JSON.stringify({
      id: "msg_stop",
      type: "message",
      role: "assistant",
      model: body.model,
      content: [{ type: "text", text: "stop ok" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 2 },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const res = await handler(jsonRequest("https://local/api/proxy?path=responses", {
    model: "claude-sonnet-4-6",
    input: "hi",
    stop: "END",
    seed: 42,
    frequency_penalty: 0.5,
    presence_penalty: 0.25,
  }));
  assert.equal(res.status, 200);
  assert.deepEqual(capturedBody.stop_sequences, ["END"]);
  assert.equal("stop" in capturedBody, false);
  assert.equal("seed" in capturedBody, false);
  assert.equal("frequency_penalty" in capturedBody, false);
  assert.equal("presence_penalty" in capturedBody, false);
}

async function testResponsesBridgeUnsupportedParameters() {
  resetEnv();
  process.env.DEEPSEEK_API_KEY = "upstream";
  let fetched = false;
  globalThis.fetch = async () => {
    fetched = true;
    throw new Error("fetch should not be called");
  };

  let res = await handler(jsonRequest("https://local/api/proxy?path=responses", {
    model: "deepseek-v4-pro",
    input: "hi",
    n: 2,
  }));
  assert.equal(res.status, 400);
  let body = await readJson(res);
  assert.equal(body.error.code, "unsupported_parameter");

  res = await handler(jsonRequest("https://local/api/proxy?path=responses", {
    model: "deepseek-v4-pro",
    input: "hi",
    logprobs: true,
  }));
  assert.equal(res.status, 400);
  body = await readJson(res);
  assert.equal(body.error.code, "unsupported_parameter");

  res = await handler(jsonRequest("https://local/api/proxy?path=responses", {
    model: "deepseek-v4-pro",
    input: "hi",
    include: ["message.output_text.logprobs"],
  }));
  assert.equal(res.status, 400);
  body = await readJson(res);
  assert.equal(body.error.code, "unsupported_parameter");
  assert.equal(fetched, false);
}

async function testRuntimeRewrites() {
  const dockerResponses = new URL(rewriteDockerUrl("/v1/responses", "localhost:3000", "http"));
  assert.equal(dockerResponses.pathname, "/api/proxy");
  assert.equal(dockerResponses.searchParams.get("path"), "responses");

  const dockerChat = new URL(rewriteDockerUrl("/v1/chat/completions", "localhost:3000", "http"));
  assert.equal(dockerChat.searchParams.get("path"), "chat/completions");

  const edgeResponses = new URL(rewriteEdgeOneProxyUrl(new Request("https://edge.example/v1/responses"), null));
  assert.equal(edgeResponses.pathname, "/api/proxy");
  assert.equal(edgeResponses.searchParams.get("path"), "responses");

  const vercel = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"));
  assert.ok(vercel.rewrites.some((route) => route.source === "/v1/:path*" && route.destination === "/api/proxy?path=:path*"));
}

async function testEdgeOneWrapperResponses() {
  resetEnv();
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(String(url), "https://api.deepseek.com/v1/chat/completions");
    assert.equal(body.messages.at(-1).content, "edge wrapper");
    return new Response(JSON.stringify({
      id: "chatcmpl_edge",
      object: "chat.completion",
      model: body.model,
      choices: [{
        index: 0,
        message: { role: "assistant", content: "edge ok" },
        finish_reason: "stop",
      }],
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const res = await edgeOneV1({
    request: jsonRequest("https://edge.example/v1/responses", {
      model: "deepseek-v4-pro",
      input: "edge wrapper",
    }),
    env: { DEEPSEEK_API_KEY: "upstream" },
  });
  assert.equal(res.status, 200);
  const body = await readJson(res);
  assert.equal(body.object, "response");
  assert.equal(body.output[0].content[0].text, "edge ok");
}

const tests = [
  testModelDiscoveryAndAuth,
  testResponsesBridgeNonStreamingAndState,
  testResponsesBridgeStreaming,
  testResponsesBridgeRepairsMissingToolOutput,
  testResponsesBridgeMovesDelayedToolOutput,
  testResponsesBridgeSkipsUnsupportedBuiltInTools,
  testAzureResponsesStaysNative,
  testAzureChatResponseFormatMapping,
  testAnthropicResponsesBridgeNonStreaming,
  testResponsesBridgeParameterForwarding,
  testResponsesBridgeAnthropicStopMapping,
  testResponsesBridgeUnsupportedParameters,
  testRuntimeRewrites,
  testEdgeOneWrapperResponses,
];

for (const test of tests) {
  await test();
  console.log(`ok ${test.name}`);
}
