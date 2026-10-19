// iCONIC on its own web address: stands in for what claude.ai normally provides (window.claude.use),
// so the very same app runs without claude.ai. The AI is reached directly from this device with the
// user's own key (Google Gemini for free, or Claude). Everything is stored only on this device.
(() => {
  "use strict";
  const CFG = "iconic.ai";
  const cfg = () => { try { return JSON.parse(localStorage.getItem(CFG) || "{}"); } catch { return {}; } };
  const saveCfg = (c) => { try { localStorage.setItem(CFG, JSON.stringify(c)); } catch { /* private mode */ } };

  const MODELS = {
    claude: { quick: "claude-haiku-5-5", default: "claude-sonnet-5-5", complex: "claude-opus-5-5" },
    gemini: { quick: "gemini-flash-lite-latest", default: "gemini-flash-latest", complex: "gemini-flash-latest" },
  };
  const MAX_ROUNDS = 12;

  const fail = (code, message, text) => Object.assign(new Error(message || code), { code, text });
  const blobToBase64 = (blob) => new Promise((ok, bad) => {
    const r = new FileReader(); r.onload = () => ok(String(r.result).split(",")[1]); r.onerror = () => bad(r.error); r.readAsDataURL(blob);
  });

  // Turn the app's input (a string or [{role, content}]) into alternating turns; the first message the app
  // sends is its instructions, which become the system prompt.
  function turnsOf(input) {
    const list = typeof input === "string" ? [{ role: "user", content: input }] : input.map((m) => ({ role: m.role, content: String(m.content) }));
    const out = [];
    for (const m of list) {
      const last = out[out.length - 1];
      if (last && last.role === m.role) last.content += "\n\n" + m.content; else out.push({ ...m });
    }
    return out;
  }

  function httpError(status, body) {
    const msg = body?.error?.message || "";
    if (status === 401 || status === 403 || /api key|API_KEY/i.test(msg)) return fail("bad_key", msg);
    if (status === 429) return fail("rate_limited", msg);
    if (status === 402 || /credit balance|billing/i.test(msg)) return fail("no_credit", msg);
    if (status === 529 || status === 503 || status === 500) return fail("overloaded", msg);
    if (status === 413 || /too long|too many tokens|context/i.test(msg)) return fail("prompt_too_large", msg);
    return fail("unavailable", msg || "HTTP " + status);
  }

  async function runTool(tools, name, input, signal) {
    const t = tools.find((x) => x.name === name);
    if (!t) return { error: true, content: "Error: unknown tool " + name };
    try {
      const r = await t.execute(input || {}, { signal });
      return { error: false, content: typeof r === "string" ? r : JSON.stringify(r ?? null) };
    } catch (e) { return { error: true, content: "Error: " + (e?.message || String(e)) }; }
  }

  // ---------- Claude (Anthropic API, streamed) ----------
  async function claudeCall(key, input, opts) {
    const model = MODELS.claude[opts.modelTier] || MODELS.claude.default;
    const turns = turnsOf(input);
    const messages = turns.map((m) => ({ role: m.role, content: [{ type: "text", text: m.content }] }));
    if (messages[0]?.role !== "user") messages.unshift({ role: "user", content: [{ type: "text", text: "Hei" }] });
    if (opts.images?.length) {
      const last = [...messages].reverse().find((m) => m.role === "user");
      for (const img of opts.images) last.content.unshift({ type: "image", source: { type: "base64", media_type: img.type || "image/png", data: await blobToBase64(img) } });
    }
    const pageTools = opts.tools || [];
    const basic = /haiku/.test(model);
    const tools = [
      ...pageTools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema || { type: "object", properties: {} } })),
      ...(opts.web === false ? [] : [{ type: basic ? "web_search_20250305" : "web_search_20260209", name: "web_search", max_uses: 5, user_location: { type: "approximate", country: "NO", timezone: "Europe/Oslo" } }]),
    ];
    let all = "";
    let truncated = false;
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST", signal: opts.signal,
        headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
        body: JSON.stringify({ model, max_tokens: 16000, stream: true, tools, messages }),
      });
      if (!res.ok) throw httpError(res.status, await res.json().catch(() => null));
      const prefix = all ? all + "\n\n" : "";
      let roundText = "";
      const blocks = []; let stop = null;
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let cut;
        while ((cut = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, cut); buf = buf.slice(cut + 2);
          const data = chunk.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
          if (!data) continue;
          const ev = JSON.parse(data);
          if (ev.type === "content_block_start") {
            const b = { ...ev.content_block };
            if (b.type === "text") { b.text = ""; delete b.citations; }
            if (b.type === "tool_use" || b.type === "server_tool_use") b._json = "";
            if (b.type === "thinking") { b.thinking = b.thinking || ""; b.signature = b.signature || ""; }
            blocks[ev.index] = b;
          } else if (ev.type === "content_block_delta") {
            const b = blocks[ev.index]; const d = ev.delta;
            if (d.type === "text_delta") { b.text += d.text; roundText += d.text; opts.onText?.({ text: prefix + roundText, delta: d.text }); }
            else if (d.type === "input_json_delta") b._json += d.partial_json;
            else if (d.type === "thinking_delta") b.thinking += d.thinking;
            else if (d.type === "signature_delta") b.signature = d.signature;
          } else if (ev.type === "content_block_stop") {
            const b = blocks[ev.index];
            if (b && "_json" in b) { try { b.input = b._json ? JSON.parse(b._json) : (b.input || {}); } catch { b.input = {}; } delete b._json; }
          } else if (ev.type === "message_delta") stop = ev.delta?.stop_reason || stop;
          else if (ev.type === "error") throw httpError(ev.error?.type === "overloaded_error" ? 529 : 500, ev);
        }
      }
      const content = blocks.filter(Boolean).filter((b) => b.type !== "text" || b.text);
      if (roundText) all = prefix + roundText;
      if (stop === "refusal") throw fail("refused");
      if (stop === "max_tokens") { truncated = true; break; }
      messages.push({ role: "assistant", content: content.length ? content : [{ type: "text", text: "…" }] });
      if (stop === "pause_turn") continue;
      const uses = content.filter((b) => b.type === "tool_use");
      if (stop !== "tool_use" || !uses.length) break;
      const results = await Promise.all(uses.map(async (u) => {
        const r = await runTool(pageTools, u.name, u.input, opts.signal);
        return { type: "tool_result", tool_use_id: u.id, content: r.content.slice(0, 32000), is_error: r.error || undefined };
      }));
      messages.push({ role: "user", content: results });
    }
    return { text: all, truncated };
  }

  // ---------- Google Gemini (free key) ----------
  // Gemini accepts only a subset of JSON Schema; keep the parts it understands.
  function geminiSchema(s) {
    if (!s || typeof s !== "object") return s;
    const out = {};
    for (const k of ["type", "description", "enum", "format", "nullable", "required"]) if (s[k] !== undefined) out[k] = s[k];
    if (Array.isArray(out.type)) out.type = out.type.find((t) => t !== "null") || "string";
    if (s.properties) { out.properties = {}; for (const [k, v] of Object.entries(s.properties)) out.properties[k] = geminiSchema(v); if (!Object.keys(out.properties).length) delete out.properties; }
    if (s.items) out.items = geminiSchema(s.items);
    if (out.type === "object" && !out.properties) { delete out.required; }
    return out;
  }
  async function geminiCall(key, input, opts) {
    const model = MODELS.gemini[opts.modelTier] || MODELS.gemini.default;
    const turns = turnsOf(input);
    const contents = turns.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
    if (contents[0]?.role !== "user") contents.unshift({ role: "user", parts: [{ text: "Hei" }] });
    if (opts.images?.length) {
      const last = [...contents].reverse().find((m) => m.role === "user");
      for (const img of opts.images) last.parts.unshift({ inlineData: { mimeType: img.type || "image/png", data: await blobToBase64(img) } });
    }
    const pageTools = opts.tools || [];
    const tools = pageTools.length ? [{ functionDeclarations: pageTools.map((t) => {
      const d = { name: t.name, description: t.description };
      const p = geminiSchema(t.inputSchema);
      if (p?.properties) d.parameters = p;
      return d;
    }) }] : undefined;
    let all = ""; let truncated = false;
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST", signal: opts.signal,
        headers: { "content-type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({ contents, tools, generationConfig: { maxOutputTokens: 8192 } }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw httpError(res.status, body);
      const cand = body?.candidates?.[0];
      if (!cand) throw fail(body?.promptFeedback?.blockReason ? "refused" : "unavailable");
      const parts = cand.content?.parts || [];
      const text = parts.filter((p) => p.text && !p.thought).map((p) => p.text).join("");
      if (text) { all = all ? all + "\n\n" + text : text; opts.onText?.({ text: all, delta: text }); }
      if (cand.finishReason === "MAX_TOKENS") { truncated = true; break; }
      if (cand.finishReason === "SAFETY" && !text) throw fail("refused");
      const calls = parts.filter((p) => p.functionCall);
      if (!calls.length) break;
      contents.push({ role: "model", parts });
      const results = await Promise.all(calls.map(async (c) => {
        const r = await runTool(pageTools, c.functionCall.name, c.functionCall.args, opts.signal);
        let response; try { response = { result: JSON.parse(r.content) }; } catch { response = { result: r.content }; }
        return { functionResponse: { name: c.functionCall.name, response } };
      }));
      contents.push({ role: "user", parts: results });
    }
    return { text: all, truncated };
  }

  // ---------- sample ----------
  async function sample(input, opts = {}) {
    const c = cfg();
    if (!c.key) { openSetup(); throw fail("needs_key"); }
    try {
      return await (c.provider === "claude" ? claudeCall : geminiCall)(c.key, input, opts);
    } catch (e) {
      if (e?.name === "AbortError" || opts.signal?.aborted) throw fail("cancelled", "Stoppet", e?.text);
      if (e?.code) throw e;
      throw fail("unavailable", e?.message);
    }
  }
  sample.json = async (input, opts = {}) => {
    const ask = typeof input === "string" ? input + "\n\nSvar KUN med gyldig JSON, uten forklaring og uten ```." : input;
    const { text } = await sample(ask, { ...opts, web: false });
    const t = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
    try { return JSON.parse(t); } catch { /* try the outermost JSON value */ }
    const m = t.match(/[[{][\s\S]*[\]}]/);
    try { return JSON.parse(m ? m[0] : ""); } catch { throw fail("invalid_json", "Ugyldig JSON", text); }
  };
  sample.limits = async () => ({ inputBytes: 2_000_000, images: { maxCount: 10, maxBytes: 5_000_000 }, tools: { maxCount: 64 } });

  // ---------- db: kept in this browser only ----------
  const db = {
    doc(path) {
      const k = "iconic.db:" + path;
      const snap = () => { const raw = localStorage.getItem(k); return { exists: raw !== null, data: () => JSON.parse(raw), metadata: { hasPendingWrites: false } }; };
      return {
        async set(body) {
          try { localStorage.setItem(k, JSON.stringify(body)); }
          catch { throw fail("quota", "Lagringsplassen på denne enheten er full."); }
        },
        async get() { return snap(); },
        onSnapshot(cb) {
          cb(snap());
          const on = (e) => { if (e.key === k) cb(snap()); };
          window.addEventListener("storage", on);
          return () => window.removeEventListener("storage", on);
        },
      };
    },
  };

  // ---------- downloads ----------
  const downloads = {
    async save({ filename, data }) {
      const blob = data instanceof Blob ? data : new Blob([data]);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = filename; document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      return { status: "saved" };
    },
  };

  const user = { id: async () => "local" };

  window.claude = {
    standalone: true,
    use: async (name) => ({ sample, db, user, downloads })[name] ?? null,
  };

  // ---------- AI key setup ----------
  let dlg;
  function openSetup() {
    if (!dlg) build();
    const c = cfg();
    dlg.querySelector(`[value="${c.provider || "gemini"}"]`).checked = true;
    dlg.querySelector("#ai-key").value = c.key || "";
    syncHelp();
    if (!dlg.open) dlg.showModal();
  }
  function syncHelp() {
    const p = dlg.querySelector("input[name=ai-provider]:checked").value;
    dlg.querySelector("#ai-help").innerHTML = p === "claude"
      ? 'Gå til <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener">console.anthropic.com</a>, logg inn, trykk <b>Create Key</b> og kopier nøkkelen hit. Du betaler per bruk (vanligvis noen få kroner om dagen). Kan søke på nettet.'
      : 'Gå til <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a>, logg inn med Google, trykk <b>Create API key</b> og kopier nøkkelen hit. Gratis. Merk: Google kan bruke det du skriver på gratisnivået til å forbedre tjenestene sine – ikke skriv inn sensitive personopplysninger.';
  }
  function build() {
    dlg = document.createElement("dialog");
    dlg.className = "sheet"; dlg.id = "ai-setup";
    dlg.innerHTML = `<form method="dialog">
      <h2>Koble til AI</h2>
      <p class="muted" style="margin-top:0">iCONIC trenger en nøkkel for å tenke. Den lagres bare på denne enheten og sendes bare til tjenesten du velger.</p>
      <div class="field">
        <span class="lbl">Tjeneste</span>
        <label style="display:flex;gap:10px;align-items:center;padding:6px 0"><input type="radio" name="ai-provider" value="gemini"> <span><b>Google Gemini</b> – gratis</span></label>
        <label style="display:flex;gap:10px;align-items:center;padding:6px 0"><input type="radio" name="ai-provider" value="claude"> <span><b>Claude</b> – smartest, betal per bruk</span></label>
      </div>
      <div class="field">
        <label for="ai-key">Nøkkel</label>
        <input id="ai-key" type="password" autocomplete="off" spellcheck="false" placeholder="Lim inn nøkkelen her">
        <small id="ai-help"></small>
      </div>
      <p id="ai-status" class="muted" role="status"></p>
      <div class="sheet-actions">
        <button type="button" id="ai-test" class="btn">Test</button>
        <button type="button" id="ai-save" class="btn primary">Lagre</button>
      </div>
    </form>`;
    document.body.append(dlg);
    dlg.addEventListener("change", (e) => { if (e.target.name === "ai-provider") syncHelp(); });
    const status = dlg.querySelector("#ai-status");
    const read = () => ({ provider: dlg.querySelector("input[name=ai-provider]:checked").value, key: dlg.querySelector("#ai-key").value.trim() });
    async function test() {
      const c = read();
      if (!c.key) { status.textContent = "Lim inn nøkkelen først."; return false; }
      status.textContent = "Tester …";
      try {
        await (c.provider === "claude" ? claudeCall : geminiCall)(c.key, "Svar bare: OK", { modelTier: "quick", web: false });
        status.textContent = "✓ Det virker!"; return true;
      } catch (e) {
        status.textContent = { bad_key: "Nøkkelen virker ikke. Sjekk at hele nøkkelen er limt inn.", no_credit: "Kontoen er tom for kreditt.", rate_limited: "For mange forsøk – vent litt." }[e.code] || "Fikk ikke kontakt: " + (e.message || e.code);
        return false;
      }
    }
    dlg.querySelector("#ai-test").addEventListener("click", test);
    dlg.querySelector("#ai-save").addEventListener("click", async () => {
      if (!(await test())) return;
      saveCfg(read()); setTimeout(() => dlg.close(), 500);
    });
  }

  // Add "AI-nøkkel" to the app's settings, and ask for a key on first start.
  document.addEventListener("DOMContentLoaded", () => {
    const actions = document.querySelector("#settings .sheet-actions");
    if (actions) {
      const b = document.createElement("button"); b.type = "button"; b.className = "btn"; b.textContent = "AI-nøkkel";
      b.addEventListener("click", () => { document.querySelector("#settings").close(); openSetup(); });
      actions.prepend(b);
    }
    if (!cfg().key) setTimeout(openSetup, 600);
  });
})();
