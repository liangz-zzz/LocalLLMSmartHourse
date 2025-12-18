export function createLlmClient({ config, logger }) {
  const base = config.llmApiBase.replace(/\/$/, "");
  const apiKey = config.llmApiKey;

  async function chat({ messages, model, temperature = 0.2, maxTokens = 800 }) {
    const url = `${base}/chat/completions`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
      },
      body: JSON.stringify({
        model: model || config.agentModel,
        messages,
        response_format: { type: "json_object" },
        temperature,
        max_tokens: maxTokens
      })
    });

    const text = await res.text().catch(() => "");
    if (!res.ok) {
      logger?.warn?.({ msg: "LLM request failed", status: res.status, body: text.slice(0, 200) });
      throw new Error(`llm_error ${res.status}: ${text.slice(0, 200)}`);
    }
    return JSON.parse(text);
  }

  return { chat };
}
