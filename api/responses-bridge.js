const RESPONSE_STATE_PREFIX = "respstate:";

function randomId(prefix) {
  const raw = globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID().replace(/-/g, "")
    : Math.random().toString(36).slice(2) + Date.now().toString(36);
  return `${prefix}_${raw.slice(0, 32)}`;
}

function cloneJson(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function responseStateKey(scopeUser, responseId) {
  return `${RESPONSE_STATE_PREFIX}${scopeUser || "anon"}:${responseId}`;
}

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object" || Array.isArray(part)) return "";
      return part.text ?? part.refusal ?? part.output_text ?? part.input_text ?? "";
    })
    .filter(Boolean)
    .join("\n");
}

function imageUrlFromResponsesPart(part) {
  if (!part || typeof part !== "object" || Array.isArray(part)) return "";
  if (typeof part.image_url === "string") return part.image_url;
  if (typeof part.image_url?.url === "string") return part.image_url.url;
  if (typeof part.url === "string") return part.url;
  return "";
}

function anthropicImagePart(url) {
  const dataMatch = /^data:([^;,]+);base64,(.+)$/i.exec(url || "");
  if (dataMatch) {
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: dataMatch[1],
        data: dataMatch[2],
      },
    };
  }
  return { type: "image", source: { type: "url", url } };
}

function normalizeContentForChat(content, role, providerKey) {
  if (typeof content === "string") return content;
  if (content == null) return "";

  const rawParts = Array.isArray(content) ? content : [content];
  const parts = [];
  let hasNonText = false;
  for (const part of rawParts) {
    if (typeof part === "string") {
      parts.push({ type: "text", text: part });
      continue;
    }
    if (!part || typeof part !== "object" || Array.isArray(part)) continue;

    if (
      part.type === "input_text" ||
      part.type === "output_text" ||
      part.type === "text" ||
      typeof part.text === "string"
    ) {
      const text = part.text ?? part.input_text ?? part.output_text ?? "";
      if (text) parts.push({ type: "text", text });
      continue;
    }

    if (part.type === "input_image" || part.type === "image_url" || part.image_url || part.url) {
      const url = imageUrlFromResponsesPart(part);
      if (!url) continue;
      hasNonText = true;
      parts.push(
        providerKey === "azureanthropic"
          ? anthropicImagePart(url)
          : { type: "image_url", image_url: { url } }
      );
      continue;
    }
  }

  if (!hasNonText) {
    return parts.map((part) => part.text || "").filter(Boolean).join("\n");
  }

  // Assistant text arrays are poorly supported by many Chat Completions
  // backends. Collapse assistant text-only content even if mixed input tried
  // to use a block array.
  if (role === "assistant" && parts.every((part) => part.type === "text")) {
    return parts.map((part) => part.text || "").filter(Boolean).join("\n");
  }

  return parts;
}

function normalizeResponseInput(input, providerKey) {
  const messages = [];
  const systemTexts = [];
  const items = Array.isArray(input) ? input : (input == null ? [] : [input]);

  for (const item of items) {
    if (typeof item === "string") {
      messages.push({ role: "user", content: item });
      continue;
    }
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;

    const type = item.type || "";
    if (type === "input_text" || type === "output_text") {
      messages.push({
        role: type === "output_text" ? "assistant" : "user",
        content: item.text || "",
      });
      continue;
    }

    if (type === "function_call_output") {
      messages.push({
        role: "tool",
        tool_call_id: item.call_id || item.id || "",
        content: typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? ""),
      });
      continue;
    }

    if (type === "function_call" || type === "custom_tool_call" || type === "apply_patch_call") {
      const callId = item.call_id || item.id || randomId("call");
      const name = type === "apply_patch_call" ? "apply_patch" : (item.name || "");
      const args = item.arguments ?? item.input ?? item.patch ?? "{}";
      messages.push({
        role: "assistant",
        content: item.content ? normalizeContentForChat(item.content, "assistant", providerKey) : null,
        tool_calls: [{
          id: callId,
          type: "function",
          function: {
            name,
            arguments: typeof args === "string" ? args : JSON.stringify(args),
          },
        }],
      });
      continue;
    }

    if (type === "reasoning") continue;

    const role = item.role || (type === "message" ? "user" : "");
    if (role) {
      const normalizedRole = role === "developer" ? "system" : role;
      const content = normalizeContentForChat(item.content, normalizedRole, providerKey);
      if (normalizedRole === "system" && providerKey === "azureanthropic") {
        const text = textFromContent(content).trim();
        if (text) systemTexts.push(text);
      } else {
        const msg = { role: normalizedRole, content };
        if (Array.isArray(item.tool_calls)) msg.tool_calls = cloneJson(item.tool_calls);
        if (item.tool_call_id) msg.tool_call_id = item.tool_call_id;
        messages.push(msg);
      }
    }
  }

  return { messages, systemTexts };
}

function convertToolChoice(toolChoice, providerKey) {
  if (!toolChoice) return undefined;
  if (providerKey === "azureanthropic") {
    if (toolChoice === "required") return { type: "any" };
    if (toolChoice === "auto") return { type: "auto" };
    if (toolChoice === "none") return { type: "none" };
    if (toolChoice?.type === "function" && toolChoice.name) {
      return { type: "tool", name: toolChoice.name };
    }
    if (toolChoice?.type === "function" && toolChoice.function?.name) {
      return { type: "tool", name: toolChoice.function.name };
    }
    return toolChoice;
  }
  if (toolChoice?.type === "function" && toolChoice.name) {
    return { type: "function", function: { name: toolChoice.name } };
  }
  return toolChoice;
}

function convertResponsesTools(tools, providerKey) {
  if (!Array.isArray(tools)) return { tools: undefined, error: null };

  const converted = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) continue;
    if (tool.type !== "function") {
      return {
        tools: null,
        error: {
          status: 400,
          code: "unsupported_tool_type",
          message: `Responses tool type "${tool.type || "unknown"}" cannot be safely converted to Chat Completions for this provider.`,
        },
      };
    }

    const name = tool.name || tool.function?.name || "";
    if (!name) {
      return {
        tools: null,
        error: {
          status: 400,
          code: "invalid_tool",
          message: "Responses function tools must include a name.",
        },
      };
    }

    const description = tool.description || tool.function?.description || "";
    const parameters = tool.parameters || tool.function?.parameters || {};

    if (providerKey === "azureanthropic") {
      converted.push({
        name,
        ...(description ? { description } : {}),
        input_schema: parameters,
      });
    } else {
      converted.push({
        type: "function",
        function: {
          name,
          ...(description ? { description } : {}),
          parameters,
        },
      });
    }
  }

  return { tools: converted, error: null };
}

export function convertResponsesRequestToChat(parsedBody, providerKey, priorMessages = []) {
  if (!parsedBody || typeof parsedBody !== "object" || Array.isArray(parsedBody)) {
    return {
      body: parsedBody,
      messages: [],
      error: {
        status: 400,
        code: "invalid_request",
        message: "Responses request body must be a JSON object.",
      },
    };
  }

  const input = Object.prototype.hasOwnProperty.call(parsedBody, "input")
    ? parsedBody.input
    : parsedBody.messages;
  const { messages: inputMessages, systemTexts } = normalizeResponseInput(input, providerKey);
  const messages = [...cloneJson(priorMessages || []), ...inputMessages];

  if (messages.length === 0 && systemTexts.length === 0) {
    return {
      body: null,
      messages: [],
      error: {
        status: 400,
        code: "missing_input",
        message: "Responses-to-Chat conversion requires an input item.",
      },
    };
  }

  const { tools, error } = convertResponsesTools(parsedBody.tools, providerKey);
  if (error) return { body: null, messages, error };

  const body = {
    model: parsedBody.model,
    messages,
  };

  if (providerKey === "azureanthropic") {
    const instructionText = [parsedBody.instructions, ...systemTexts]
      .filter((value) => typeof value === "string" && value.trim())
      .join("\n\n");
    if (instructionText) body.system = instructionText;
  } else if (parsedBody.instructions) {
    body.messages = [
      { role: "system", content: String(parsedBody.instructions) },
      ...body.messages,
    ];
  }

  if ("stream" in parsedBody) body.stream = parsedBody.stream;
  if ("temperature" in parsedBody) body.temperature = parsedBody.temperature;
  if ("top_p" in parsedBody) body.top_p = parsedBody.top_p;
  if ("user" in parsedBody) body.user = parsedBody.user;
  if ("metadata" in parsedBody) body.metadata = parsedBody.metadata;
  if ("parallel_tool_calls" in parsedBody) body.parallel_tool_calls = parsedBody.parallel_tool_calls;
  if ("max_output_tokens" in parsedBody) body.max_tokens = parsedBody.max_output_tokens;
  if ("max_completion_tokens" in parsedBody && !("max_tokens" in body)) {
    body.max_tokens = parsedBody.max_completion_tokens;
  }
  if (tools?.length) body.tools = tools;
  const toolChoice = convertToolChoice(parsedBody.tool_choice, providerKey);
  if (toolChoice !== undefined) body.tool_choice = toolChoice;

  return { body, messages: body.messages, error: null };
}

export async function readResponsesBridgeState(previousResponseId, scopeUser, kvGet) {
  if (!previousResponseId) return { state: null, error: null };
  const raw = await kvGet(responseStateKey(scopeUser, previousResponseId));
  if (!raw) {
    return {
      state: null,
      error: {
        status: 404,
        code: "previous_response_not_found",
        message: `No stored response was found for previous_response_id "${previousResponseId}".`,
      },
    };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.messages)) throw new Error("missing messages");
    return { state: parsed, error: null };
  } catch {
    return {
      state: null,
      error: {
        status: 500,
        code: "invalid_response_state",
        message: "Stored response state is invalid.",
      },
    };
  }
}

export async function writeResponsesBridgeState(responseId, scopeUser, state, kvSet) {
  if (!responseId || !state?.store) return;
  await kvSet(responseStateKey(scopeUser, responseId), JSON.stringify({
    providerKey: state.providerKey,
    model: state.model,
    ...(state.system ? { system: state.system } : {}),
    messages: state.messages,
  }));
}

function chatFinishToResponseStatus(finishReason) {
  return finishReason === "length" ? "incomplete" : "completed";
}

function chatUsageToResponsesUsage(usage) {
  if (!usage) return undefined;
  return {
    input_tokens: usage.prompt_tokens ?? 0,
    output_tokens: usage.completion_tokens ?? 0,
    total_tokens: usage.total_tokens ?? ((usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0)),
  };
}

function responseMessageItem(text, itemId = randomId("msg")) {
  return {
    id: itemId,
    type: "message",
    status: "completed",
    role: "assistant",
    content: text
      ? [{ type: "output_text", text, annotations: [] }]
      : [],
  };
}

function responseFunctionCallItem(toolCall) {
  return {
    id: randomId("fc"),
    type: "function_call",
    status: "completed",
    call_id: toolCall.id || randomId("call"),
    name: toolCall.function?.name || "",
    arguments: toolCall.function?.arguments || "{}",
  };
}

export function chatCompletionToResponses(json, responseId, responseModelName) {
  const choice = json?.choices?.[0] || {};
  const message = choice.message || {};
  const output = [];
  const content = textFromContent(message.content);
  if (content || !Array.isArray(message.tool_calls) || message.tool_calls.length === 0) {
    output.push(responseMessageItem(content));
  }
  if (Array.isArray(message.tool_calls)) {
    for (const toolCall of message.tool_calls) {
      output.push(responseFunctionCallItem(toolCall));
    }
  }

  const status = chatFinishToResponseStatus(choice.finish_reason);
  return {
    id: responseId,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status,
    model: responseModelName || json?.model || "",
    output,
    ...(status === "incomplete" ? { incomplete_details: { reason: "max_output_tokens" } } : {}),
    ...(json?.usage ? { usage: chatUsageToResponsesUsage(json.usage) } : {}),
  };
}

export function assistantMessageFromChatCompletion(json) {
  const message = json?.choices?.[0]?.message || {};
  return {
    role: "assistant",
    content: message.content ?? null,
    ...(Array.isArray(message.tool_calls) && message.tool_calls.length
      ? { tool_calls: cloneJson(message.tool_calls) }
      : {}),
  };
}

export function createChatToResponsesStreamState(responseId, responseModelName) {
  return {
    responseId,
    model: responseModelName || "",
    createdAt: Math.floor(Date.now() / 1000),
    messageItemId: randomId("msg"),
    messageItemAdded: false,
    content: "",
    finishReason: null,
    toolCalls: new Map(),
    outputIndexByToolIndex: new Map(),
  };
}

function baseStreamResponse(state, status = "in_progress", output = []) {
  return {
    id: state.responseId,
    object: "response",
    created_at: state.createdAt,
    status,
    model: state.model,
    output,
  };
}

function eventFrame(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`;
}

export function responsesStreamStartEvents(state) {
  return [
    eventFrame("response.created", { response: baseStreamResponse(state) }),
  ];
}

function ensureMessageItemEvent(state, events) {
  if (state.messageItemAdded) return;
  state.messageItemAdded = true;
  events.push(eventFrame("response.output_item.added", {
    response_id: state.responseId,
    output_index: 0,
    item: {
      id: state.messageItemId,
      type: "message",
      status: "in_progress",
      role: "assistant",
      content: [],
    },
  }));
}

export function chatChunkToResponsesEvents(state, chunk) {
  const events = [];
  const choice = chunk?.choices?.[0] || {};
  const delta = choice.delta || {};
  if (choice.finish_reason) state.finishReason = choice.finish_reason;

  if (delta.content != null) {
    ensureMessageItemEvent(state, events);
    const text = String(delta.content);
    state.content += text;
    events.push(eventFrame("response.output_text.delta", {
      response_id: state.responseId,
      item_id: state.messageItemId,
      output_index: 0,
      content_index: 0,
      delta: text,
    }));
  }

  if (Array.isArray(delta.tool_calls)) {
    for (const toolDelta of delta.tool_calls) {
      const idx = toolDelta.index ?? 0;
      let stateForTool = state.toolCalls.get(idx);
      if (!stateForTool) {
        const outputIndex = Math.max(1, state.outputIndexByToolIndex.size + 1);
        stateForTool = {
          id: toolDelta.id || randomId("call"),
          name: toolDelta.function?.name || "",
          arguments: "",
          outputIndex,
        };
        state.toolCalls.set(idx, stateForTool);
        state.outputIndexByToolIndex.set(idx, outputIndex);
        events.push(eventFrame("response.output_item.added", {
          response_id: state.responseId,
          output_index: outputIndex,
          item: {
            id: randomId("fc"),
            type: "function_call",
            status: "in_progress",
            call_id: stateForTool.id,
            name: stateForTool.name,
            arguments: "",
          },
        }));
      }
      if (toolDelta.id) stateForTool.id = toolDelta.id;
      if (toolDelta.function?.name) stateForTool.name = toolDelta.function.name;
      const argDelta = toolDelta.function?.arguments || "";
      if (argDelta) {
        stateForTool.arguments += argDelta;
        events.push(eventFrame("response.function_call_arguments.delta", {
          response_id: state.responseId,
          item_id: stateForTool.id,
          output_index: stateForTool.outputIndex,
          delta: argDelta,
        }));
      }
    }
  }

  return events;
}

export function responsesStreamDoneEvents(state) {
  const events = [];
  const output = [];
  if (state.messageItemAdded || state.content || state.toolCalls.size === 0) {
    events.push(eventFrame("response.output_text.done", {
      response_id: state.responseId,
      item_id: state.messageItemId,
      output_index: 0,
      content_index: 0,
      text: state.content,
    }));
    const item = responseMessageItem(state.content, state.messageItemId);
    output.push(item);
    events.push(eventFrame("response.output_item.done", {
      response_id: state.responseId,
      output_index: 0,
      item,
    }));
  }

  for (const tool of state.toolCalls.values()) {
    const item = {
      id: randomId("fc"),
      type: "function_call",
      status: "completed",
      call_id: tool.id,
      name: tool.name,
      arguments: tool.arguments || "{}",
    };
    output.push(item);
    events.push(eventFrame("response.function_call_arguments.done", {
      response_id: state.responseId,
      item_id: tool.id,
      output_index: tool.outputIndex,
      arguments: tool.arguments || "{}",
    }));
    events.push(eventFrame("response.output_item.done", {
      response_id: state.responseId,
      output_index: tool.outputIndex,
      item,
    }));
  }

  const status = chatFinishToResponseStatus(state.finishReason);
  const response = baseStreamResponse(state, status, output);
  if (status === "incomplete") {
    response.incomplete_details = { reason: "max_output_tokens" };
  }
  events.push(eventFrame(status === "incomplete" ? "response.incomplete" : "response.completed", {
    response,
  }));
  events.push("data: [DONE]\n\n");
  return events;
}

export function assistantMessageFromResponsesStreamState(state) {
  const toolCalls = [...state.toolCalls.values()].map((tool) => ({
    id: tool.id,
    type: "function",
    function: {
      name: tool.name,
      arguments: tool.arguments || "{}",
    },
  }));
  return {
    role: "assistant",
    content: state.content || null,
    ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
  };
}

export function newResponseId() {
  return randomId("resp");
}
