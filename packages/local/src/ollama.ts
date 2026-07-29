import {
  LocalModelError,
  type GenerateOptions,
  type HealthResult,
  type LocalModelProvider,
} from "@yuhi/shared";

export interface OllamaOptions {
  /** Base endpoint. Default http://localhost:11434 */
  endpoint?: string;
  /** Default model. Default gemma3:4b */
  model?: string;
  /** Default per-request timeout in ms. Default 120_000 */
  timeoutMs?: number;
  /** Injectable fetch (for tests). Default global fetch. */
  fetchImpl?: typeof fetch;
}

interface TagsResponse {
  models?: { name?: string }[];
}
interface ChatResponse {
  choices?: { message?: { content?: string } }[];
}

/**
 * Ollama provider. Talks to a LOCAL Ollama daemon only:
 *   - GET  /api/tags               → installed models (health + discovery)
 *   - POST /v1/chat/completions    → generation (OpenAI-compatible endpoint)
 *
 * No cloud calls. Never pulls a model (that is an explicit, separate user action).
 */
export function createOllamaProvider(opts: OllamaOptions = {}): LocalModelProvider {
  const endpoint = (opts.endpoint ?? "http://127.0.0.1:11434").replace(/\/+$/, "");
  const defaultModel = opts.model ?? "qwen3:1.7b";
  const defaultTimeout = opts.timeoutMs ?? 120_000;
  const doFetch = opts.fetchImpl ?? fetch;

  async function request(
    path: string,
    init: RequestInit,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<Response> {
    const ctrl = new AbortController();
    let timedOut = false;
    const onAbort = () => ctrl.abort();
    if (signal) {
      if (signal.aborted) ctrl.abort();
      else signal.addEventListener("abort", onAbort);
    }
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, timeoutMs);
    try {
      return await doFetch(`${endpoint}${path}`, { ...init, signal: ctrl.signal });
    } catch (cause) {
      if (signal?.aborted && !timedOut) {
        throw new LocalModelError("CANCELLED", "Local model request was cancelled.", { cause });
      }
      if (timedOut) {
        throw new LocalModelError(
          "TIMEOUT",
          `Local model request timed out after ${timeoutMs} ms.`,
          { hint: "Try a smaller input, a smaller model, or a longer timeout.", cause },
        );
      }
      throw new LocalModelError("NOT_RUNNING", `Cannot reach Ollama at ${endpoint}.`, {
        hint: "Is Ollama running? Start it with `ollama serve` (see `yuhi setup-local-ai`).",
        cause,
      });
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    }
  }

  async function listModels(): Promise<string[]> {
    const res = await request("/api/tags", { method: "GET" }, Math.min(defaultTimeout, 10_000));
    if (!res.ok) {
      throw new LocalModelError("REQUEST_FAILED", `Ollama /api/tags returned HTTP ${res.status}.`);
    }
    let body: TagsResponse;
    try {
      body = (await res.json()) as TagsResponse;
    } catch (cause) {
      throw new LocalModelError("MALFORMED_RESPONSE", "Ollama /api/tags returned invalid JSON.", {
        cause,
      });
    }
    return (body.models ?? [])
      .map((m) => m.name)
      .filter((n): n is string => typeof n === "string");
  }

  async function health(): Promise<HealthResult> {
    try {
      const models = await listModels();
      return { ok: true, detail: `Ollama reachable (${models.length} model(s))`, endpoint, models };
    } catch (e) {
      const err = e as LocalModelError;
      return {
        ok: false,
        detail: err.code === "TIMEOUT" ? "Ollama did not respond in time" : "Ollama not reachable",
        endpoint,
      };
    }
  }

  async function generate(prompt: string, options: GenerateOptions = {}): Promise<string> {
    const model = options.model ?? defaultModel;
    const messages: { role: string; content: string }[] = [];
    if (options.system) messages.push({ role: "system", content: options.system });
    messages.push({ role: "user", content: prompt });

    const payload: Record<string, unknown> = { model, messages, stream: false };
    if (options.temperature !== undefined) payload.temperature = options.temperature;
    if (options.maxTokens !== undefined) payload.max_tokens = options.maxTokens;

    const res = await request(
      "/v1/chat/completions",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      },
      options.timeoutMs ?? defaultTimeout,
      options.signal,
    );

    if (!res.ok) {
      let text = "";
      try {
        text = await res.text();
      } catch {
        /* ignore */
      }
      if (res.status === 404 || /not found|try pulling|no such model/i.test(text)) {
        throw new LocalModelError("MODEL_NOT_FOUND", `Model "${model}" is not installed.`, {
          hint: `Install it with \`ollama pull ${model}\` (or run \`yuhi setup-local-ai\`).`,
        });
      }
      throw new LocalModelError(
        "REQUEST_FAILED",
        `Ollama chat returned HTTP ${res.status}.`,
        text ? { hint: text.slice(0, 200) } : {},
      );
    }

    let body: ChatResponse;
    try {
      body = (await res.json()) as ChatResponse;
    } catch (cause) {
      throw new LocalModelError("MALFORMED_RESPONSE", "Ollama chat returned invalid JSON.", {
        cause,
      });
    }
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.length === 0) {
      throw new LocalModelError("MALFORMED_RESPONSE", "Ollama chat returned an empty completion.");
    }
    return content;
  }

  return { id: "ollama", endpoint, defaultModel, health, listModels, generate };
}
