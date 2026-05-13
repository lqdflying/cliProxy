const PUBLIC_MODEL_PREFIX = "vscodeproxy/";
const REMOVED_MODEL_PREFIX = "cursorproxy/";
const LEGACY_AZURE_MODEL_PREFIX = "azure/";
const ACCEPTED_MODEL_PREFIXES = [
  PUBLIC_MODEL_PREFIX,
  LEGACY_AZURE_MODEL_PREFIX,
];

// Azure OpenAI alias registry. Public model ids in this map resolve to a real
// Azure Foundry deployment via the env var named in `targetEnv`. Each alias
// also carries an optional `effortEnv` whose value (when set) overrides the
// global AZURE_OPENAI_REASONING_EFFORT for requests that route through the
// alias. The alias name is matched against the *bare* model id, i.e. after
// `vscodeproxy/` or `azure/` has been stripped by `modelIdParts()`.
const AZURE_OPENAI_ALIASES = {
  "gpt-general": {
    targetEnv: "AZURE_OPENAI_GENERAL_ALIAS_TARGET",
    effortEnv: "AZURE_OPENAI_GENERAL_REASONING_EFFORT",
  },
};

function readAliasEnv(name) {
  const raw = process.env[name];
  if (typeof raw !== "string") return "";
  return raw.trim().replace(/^(["'])(.*)\1$/, "$2");
}

export function modelIdParts(model) {
  if (typeof model !== "string") {
    return {
      input: "",
      bare: "",
      publicId: "",
      responseId: "",
      hadPublicPrefix: false,
      hadLegacyAzurePrefix: false,
      prefix: "",
    };
  }

  let id = model.trim();
  const lower = id.toLowerCase();
  let prefix = "";
  for (const candidate of ACCEPTED_MODEL_PREFIXES) {
    if (lower.startsWith(candidate)) {
      prefix = candidate;
      id = id.slice(candidate.length);
      break;
    }
  }

  const bare = id.trim();
  const hadPublicPrefix = prefix === PUBLIC_MODEL_PREFIX;
  const hadLegacyAzurePrefix = prefix === LEGACY_AZURE_MODEL_PREFIX;
  return {
    input: model,
    bare,
    publicId: bare ? PUBLIC_MODEL_PREFIX + bare : "",
    responseId: bare ? (prefix ? prefix + bare : bare) : "",
    hadPublicPrefix,
    hadLegacyAzurePrefix,
    prefix,
  };
}

export function publicModelId(model) {
  return modelIdParts(model).publicId;
}

export function hasUnsupportedModelPrefix(model) {
  return typeof model === "string"
    && model.trim().toLowerCase().startsWith(REMOVED_MODEL_PREFIX);
}

export function withPublicResponseModel(json, fallbackModel, forceAlias = false) {
  if (!json || typeof json !== "object" || Array.isArray(json)) return json;

  // Error envelopes flow through unchanged. Even shapes like
  // `{ error: {...}, model: "<deployment>" }` must not be normalized:
  // any rewriting risks confusing client error parsers and leaks the
  // resolved deployment name when a forced-alias request fails upstream.
  if (json.error) return json;

  const fallbackId = typeof fallbackModel === "string" ? fallbackModel.trim() : "";

  // When an alias is in use, the upstream `json.model` is the resolved
  // deployment name (e.g. "gpt-5.5-mini"). Force the response model back
  // to the client-facing alias id so callers see the model they asked for.
  //
  // Restrict model stamping to payloads that look like OpenAI client responses.
  const looksLikeClientResponse =
    Array.isArray(json.choices) ||
    json.object === "response" ||
    Array.isArray(json.output);
  if (fallbackId && (forceAlias || looksLikeClientResponse)) {
    return { ...json, model: fallbackId };
  }

  const shouldAddFallback = fallbackId && looksLikeClientResponse;
  if (!shouldAddFallback) return json;

  return { ...json, model: fallbackId };
}

export function normalizeParsedBodyModel(parsedBody) {
  if (!parsedBody?.model) {
    return { input: "", bare: "", publicId: "", responseId: "", changed: false };
  }

  const parts = modelIdParts(parsedBody.model);
  const changed = Boolean(parts.bare && parsedBody.model !== parts.bare);
  if (changed) {
    parsedBody.model = parts.bare;
  }
  return { ...parts, changed };
}

export function configuredModelIds() {
  const raw = process.env.VSCODEPROXY_MODELS || "";
  const seen = new Set();
  const models = [];

  for (const value of raw.split(/[,\r\n]+/)) {
    if (hasUnsupportedModelPrefix(value)) continue;
    const { bare } = modelIdParts(value);
    if (!bare) continue;
    for (const id of [bare, PUBLIC_MODEL_PREFIX + bare]) {
      if (seen.has(id)) continue;
      seen.add(id);
      models.push(id);
    }
  }

  return models;
}

export function isModelDiscoveryRequest(req, pathname, pathParam) {
  const method = req.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") return false;

  const normalizedPathParam = pathParam.replace(/^\/+|\/+$/g, "");
  return normalizedPathParam === "models" || pathname === "/v1/models" || pathname === "/v0/models";
}

export function modelDiscoveryResponse(req) {
  const body = JSON.stringify({
    object: "list",
    data: configuredModelIds().map((id) => ({
      id,
      object: "model",
      owned_by: "vscodeProxy",
    })),
  });

  return new Response(req.method.toUpperCase() === "HEAD" ? null : body, {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}

export function providerFromModel(model) {
  if (typeof model !== "string" || !model) return null;
  const parts = modelIdParts(model);
  const m = parts.bare.toLowerCase();
  // Compatibility: azure/ IDs route to Azure and are normalized at the
  // client-facing boundary.
  if (parts.hadLegacyAzurePrefix) {
    return m.startsWith("claude") ? "azureanthropic" : "azureopenai";
  }
  if (m.startsWith("claude")) return "azureanthropic";
  // Azure OpenAI aliases route to azureopenai even when the alias name
  // doesn't start with `gpt-` / `o<digit>`. The actual deployment is
  // resolved later via resolveAzureAlias().
  if (Object.prototype.hasOwnProperty.call(AZURE_OPENAI_ALIASES, m)) {
    return "azureopenai";
  }
  if (m.startsWith("gpt-") || /^o\d/i.test(m)) return "azureopenai";
  if (m.startsWith("minimax")) return "minimax";
  if (m.startsWith("kimi")) return "kimi";
  if (m.startsWith("deepseek")) return "deepseek";
  return null;
}

// Resolve an Azure OpenAI alias name to its real deployment name.
//
// `bare` is the model id after `vscodeproxy/` / `azure/` prefix
// stripping (i.e. `modelIdParts(model).bare`).
//
// Return values:
//   - `null` when `bare` is not a registered alias.
//   - `{ aliasName, target, effortEnv, targetEnv, configured: false }`
//     when the alias is registered but its target env var is unset/blank.
//     The proxy uses `configured: false` to surface a clear configuration
//     error to clients instead of forwarding a request that would 400.
//   - `{ aliasName, target, effortEnv, targetEnv, configured: true }`
//     when the target deployment was successfully resolved. `target` is
//     the bare deployment name (any proxy prefix accidentally
//     placed in the env var is stripped here defensively).
export function resolveAzureAlias(bare) {
  if (typeof bare !== "string" || !bare) return null;
  const key = bare.toLowerCase();
  const meta = Object.prototype.hasOwnProperty.call(AZURE_OPENAI_ALIASES, key)
    ? AZURE_OPENAI_ALIASES[key]
    : null;
  if (!meta) return null;

  const rawTarget = readAliasEnv(meta.targetEnv);
  if (!rawTarget) {
    return {
      aliasName: key,
      target: "",
      effortEnv: meta.effortEnv || null,
      targetEnv: meta.targetEnv,
      configured: false,
    };
  }

  // Defensive: strip any `vscodeproxy/` or `azure/` prefix the operator
  // may have accidentally written into the env var.
  const target = modelIdParts(rawTarget).bare;
  return {
    aliasName: key,
    target,
    effortEnv: meta.effortEnv || null,
    targetEnv: meta.targetEnv,
    configured: Boolean(target),
  };
}
