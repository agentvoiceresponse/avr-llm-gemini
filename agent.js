/**
 * agent.js
 * The Gemini agent behind index.js (HTTP /prompt-stream for avr-core's ASR -> LLM -> TTS
 * pipeline): everything except the HTTP handling.
 *
 * Owns the system prompt, tools, hooks, per-call context (current date/time, the caller's
 * number/name from avr-ami, tool results from earlier turns) and one caller turn: streaming
 * Gemini's reply and running the function-calling loop, so tool results go back to Gemini
 * and the caller hears a natural answer instead of raw tool output.
 * GEMINI_WEB_SEARCH=true adds Google Search grounding.
 *
 * @author Agent Voice Response <info@agentvoiceresponse.com>
 * @author Zohair Raza <https://github.com/zohairraza>
 * @see https://www.agentvoiceresponse.com
 */
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { GoogleGenAI } = require("@google/genai");
const { loadTools, getToolHandler } = require("./loadTools");

require("dotenv").config({ quiet: true });

const MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash";
const MAX_TOOL_ROUNDS = 3;
// Rough speaking rate of the TTS voice, for estimating how long text takes to play.
const SPOKEN_CHARS_PER_SECOND = 14;
const AMI_URL = process.env.AMI_URL || "http://127.0.0.1:6006";
// Spoken while tools run, so the caller doesn't sit through seconds of silence (some take several seconds).
const TOOL_FILLER = "Just a moment while I take care of that.";
// The filler covers a silent tool round (tool + the model's next reply); fast ones need none.
// Played before every tool it was repetitive (live: 5 times in one call).
const FILLER_DELAY_MS = 1200;
const WEB_SEARCH = ["1", "true", "yes", "on"].includes(String(process.env.GEMINI_WEB_SEARCH || "").toLowerCase());

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY });

/**
 * System prompt: SYSTEM_PROMPT_FILE (read once) and/or SYSTEM_PROMPT. When both are set,
 * SYSTEM_PROMPT is appended, e.g. for notes specific to this deployment of a shared prompt.
 */
const systemPrompt =
  [process.env.SYSTEM_PROMPT_FILE && fs.readFileSync(process.env.SYSTEM_PROMPT_FILE, "utf8"), process.env.SYSTEM_PROMPT]
    .filter(Boolean)
    .join("\n\n") || "You are a helpful assistant.";

/**
 * One line telling the model the current local date and time. Models have no clock, so
 * without this "tomorrow" or "next Monday" can't be turned into a real date.
 */
const currentDateLine = () => {
  const timeZone = process.env.CALL_TIMEZONE || "UTC";
  const now = new Date().toLocaleString("en-GB", {
    timeZone, weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit",
  });
  return `Current date and time: ${now} (${timeZone}). Use it to resolve relative dates like "today", "tomorrow" or "next Monday" into exact dates.`;
};

/** Optional hooks (AVR_HOOKS_PATH, default ./hooks); only onCallEnd is used here. */
const loadHooks = () => {
  const hooksPath = process.env.AVR_HOOKS_PATH || path.join(__dirname, "hooks");
  try {
    if (!fs.existsSync(hooksPath)) return {};
    const hooks = require(hooksPath);
    console.log(`Loaded hooks from ${hooksPath}: ${Object.keys(hooks).join(", ") || "(none)"}`);
    return hooks;
  } catch (error) {
    console.error(`Failed to load hooks from ${hooksPath}: ${error.message}`);
    return {};
  }
};
const hooks = loadHooks();

const tools = loadTools();
console.log(`Loaded ${tools.length} tools: ${tools.map((t) => t.name).join(", ")}`);

const declaredTools = new Set(tools.map((t) => t.name));

const geminiTools = [
  ...(WEB_SEARCH ? [{ googleSearch: {} }] : []),
  ...(tools.length ? [{ functionDeclarations: tools }] : []),
];

const generationConfig = {
  temperature: parseFloat(process.env.GEMINI_TEMPERATURE || "0.3"),
  maxOutputTokens: parseInt(process.env.GEMINI_MAX_TOKENS || "300", 10),
  // Keep latency low for voice: minimal reasoning before answering.
  thinkingConfig: { thinkingLevel: process.env.GEMINI_THINKING_LEVEL || "minimal" },
  ...(geminiTools.length ? { tools: geminiTools } : {}),
  // Required by the API when built-in tools (search) are combined with function calling.
  ...(WEB_SEARCH && tools.length ? { toolConfig: { includeServerSideToolInvocations: true } } : {}),
};
if (WEB_SEARCH) console.log("Google Search grounding enabled");

/**
 * The part of every request that never changes within a call (and is context-cached):
 * system prompt and tool declarations.
 */
const staticConfig = {
  systemInstruction: systemPrompt,
  ...(generationConfig.tools ? { tools: generationConfig.tools } : {}),
  ...(generationConfig.toolConfig ? { toolConfig: generationConfig.toolConfig } : {}),
};

/**
 * Explicit context caching (GEMINI_CACHE_TTL_SECONDS > 0): the static part of every request --
 * system prompt and tool declarations -- is stored once as a Gemini cachedContent and billed at
 * the cached-token rate (~10x cheaper) instead of being resent at full price with every reply.
 * Implicit caching proved unreliable for this (0 cached tokens on repeated identical prompts).
 * The cache lives while calls keep using it (TTL renewed at half-life) and then expires, so
 * storage is only paid while the line is busy. Per-turn context (date, caller, notes) goes into
 * the conversation instead, since a cached request can't add a system instruction.
 */
const CACHE_TTL_SECONDS = parseInt(process.env.GEMINI_CACHE_TTL_SECONDS || "0", 10);
let cacheEntry = null; // { name, expiresAt } | { pending } | { failedUntil }

/** @returns {Promise<string|null>} the cachedContent name for staticConfig, or null */
const contextCache = async () => {
  if (!CACHE_TTL_SECONDS) return null;
  const now = Date.now();
  const entry = cacheEntry;
  if (entry?.pending) return entry.pending;
  if (entry?.failedUntil > now) return null;
  if (entry?.name && entry.expiresAt - now > 30000) {
    if (entry.expiresAt - now < (CACHE_TTL_SECONDS * 1000) / 2) {
      entry.expiresAt = now + CACHE_TTL_SECONDS * 1000;
      ai.caches.update({ name: entry.name, config: { ttl: `${CACHE_TTL_SECONDS}s` } })
        .catch((error) => console.warn(`context cache renewal failed: ${error.message}`));
    }
    return entry.name;
  }
  const pending = ai.caches
    .create({ model: MODEL, config: { ...staticConfig, ttl: `${CACHE_TTL_SECONDS}s` } })
    .then((cache) => {
      cacheEntry = { name: cache.name, expiresAt: Date.now() + CACHE_TTL_SECONDS * 1000 };
      console.log(`context cache created: ${cache.name} (${cache.usageMetadata?.totalTokenCount} tokens)`);
      return cache.name;
    })
    .catch((error) => {
      // e.g. too few tokens for a cache: run uncached for a while, then try again.
      console.warn(`context cache unavailable, sending the full prompt: ${error.message}`);
      cacheEntry = { failedUntil: Date.now() + 10 * 60 * 1000 };
      return null;
    });
  cacheEntry = { pending };
  return pending;
};

/** Forgets a cache the API no longer knows (expired or deleted elsewhere). */
const dropContextCache = (name) => {
  if (cacheEntry?.name === name) cacheEntry = null;
};

/**
 * Converts chat messages ({ role: "system"|"user"|"assistant", content }) into Gemini
 * contents. System messages are appended to the system prompt; consecutive turns from the
 * same role are merged.
 */
const toContents = (messages) => {
  const contents = [];
  const extraSystem = [];
  for (const { role, content } of messages) {
    if (!content) continue;
    if (role === "system") {
      extraSystem.push(content);
      continue;
    }
    const geminiRole = role === "assistant" ? "model" : "user";
    const last = contents[contents.length - 1];
    if (last && last.role === geminiRole) last.parts[0].text += `\n${content}`;
    else contents.push({ role: geminiRole, parts: [{ text: content }] });
  }
  // Gemini expects the conversation to open with a user turn (the greeting comes first).
  if (contents[0]?.role === "model") contents.unshift({ role: "user", parts: [{ text: "(call connected)" }] });
  return { contents, extraSystem };
};

/** Fresh per-call agent state. */
// usage: Gemini's own token counts, summed per call (passed to onCallEnd). A request aborted before its
// last chunk (e.g. a reply started early and dropped) reports no usage, but is still billed.
const newAgentState = () => ({
  caller: undefined, toolLog: [], toolsCalled: [],
  usage: { requests: 0, unreported: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0 },
});

/** Adds one request's usageMetadata (null if it never arrived) to the call's totals. */
const addUsage = (state, usage) => {
  const total = state.usage;
  total.requests++;
  if (!usage) return void total.unreported++;
  total.inputTokens += usage.promptTokenCount || 0;
  total.cachedTokens += usage.cachedContentTokenCount || 0;
  total.outputTokens += (usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0);
};

/**
 * Caller number/name from avr-ami. The dialplan must set AVR_CALLER_NUM / AVR_CALLER_NAME
 * (avr-ami exposes AVR_* variables lowercased without the prefix). Returns null if unknown.
 */
const lookupCaller = async (uuid) => {
  try {
    const { data } = await axios.post(`${AMI_URL}/variables`, { uuid }, { timeout: 1000 });
    const num = data.caller_num || null;
    // Caller ID name is often empty or just the number again; only keep a real name.
    const name = data.caller_name && data.caller_name !== num && !/^\+?\d+$/.test(data.caller_name) ? data.caller_name : null;
    return num || name ? { num, name } : null;
  } catch (error) {
    console.warn(`[${uuid}] caller lookup failed: ${error.response?.status || error.message}`);
    return null;
  }
};

/** Extra system context for this call: caller ID and earlier tool results. */
const callContext = (state) => {
  const lines = [];
  if (state.caller?.num) lines.push(`Caller's phone number (from caller ID): ${state.caller.num}. Don't ask for it; confirm it if a callback number is needed.`);
  if (state.caller?.name) lines.push(`Caller ID name: ${state.caller.name}. This may be a person or a company, so confirm before addressing them by it.`);
  // Knowing a name makes models "complete" the contact details; stop that explicitly.
  lines.push("You only know the caller's email address if they said it in this call. Never guess, construct or assume one -- ask them to spell it.");
  if (process.env.SUPPORT_EMAIL) {
    lines.push(`If the caller's email address still isn't right after two read-backs, stop trying: ask them to send an email to ${process.env.SUPPORT_EMAIL} instead (say it once, clearly) and carry on with the call.`);
  }
  if (state.toolLog.length) {
    lines.push("Tool results from earlier in this call (use them instead of calling the same tool again with the same input):");
    for (const entry of state.toolLog) lines.push(`- ${entry}`);
  }
  return lines.join("\n");
};

/**
 * Retries once on transient Gemini errors (rate limit / overload), but only while
 * `canRetry()` holds -- i.e. nothing has been sent to the caller yet.
 */
const withRetry = async (fn, canRetry) => {
  try {
    return await fn();
  } catch (error) {
    const transient = [429, 500, 503].includes(error.status);
    if (!transient || !canRetry()) throw error;
    console.warn(`Gemini ${error.status}, retrying once`);
    await new Promise((r) => setTimeout(r, 400));
    return fn();
  }
};

/**
 * Runs one caller turn: streams Gemini's reply through `onText`, running tools as requested.
 * avr_hangup isn't run here -- it is reported as `hangupRequested` so the caller of runTurn can
 * end the call once the closing line has played.
 *
 * @param {object} args
 * @param {string} args.uuid
 * @param {object} args.state - from newAgentState(); caller is looked up on first use
 * @param {Array<{role: string, content: string}>} args.messages - conversation so far
 * @param {string[]} [args.notes] - extra system notes for this turn only
 * @param {AbortSignal} args.signal
 * @param {(text: string) => void} args.onText - receives the reply, sentence-ish chunks
 * @returns {Promise<{ text: string, hangupRequested: boolean }>} throws on Gemini failure
 */
const runTurn = async ({ uuid, state, messages, notes = [], signal, onText }) => {
  if (state.caller === undefined) state.caller = await lookupCaller(uuid);
  const { contents, extraSystem } = toContents(messages);
  const { tools: _tools, toolConfig: _toolConfig, ...sampling } = generationConfig;
  const turnContext = [...extraSystem, currentDateLine(), callContext(state), ...notes].filter(Boolean).join("\n\n");
  let cacheName = await contextCache();
  // Uncached: everything in the system instruction, as before.
  const uncachedConfig = { ...sampling, ...staticConfig, systemInstruction: `${systemPrompt}\n\n${turnContext}`, abortSignal: signal };
  // Cached: the per-turn context goes with the caller's latest message instead.
  // (on the caller's own message -- tool rounds append function responses after it)
  const callerIndex = contents.findLastIndex((c) => c.role === "user");
  const cachedContents = () =>
    contents.map((c, i) =>
      i === callerIndex
        ? { ...c, parts: [{ text: `[Context for this reply -- from the call system, not said by the caller:\n${turnContext}]` }, ...c.parts] }
        : c
    );
  const generate = async () => {
    if (cacheName) {
      try {
        return await ai.models.generateContentStream({ model: MODEL, contents: cachedContents(), config: { ...sampling, cachedContent: cacheName, abortSignal: signal } });
      } catch (error) {
        if (signal.aborted || !/cache|not found|404|permission/i.test(error.message)) throw error;
        console.warn(`[${uuid}] context cache ${cacheName} failed (${error.message}); sending the full prompt`);
        dropContextCache(cacheName);
        cacheName = null;
      }
    }
    return ai.models.generateContentStream({ model: MODEL, contents, config: uncachedConfig });
  };

  let text = "";
  let hangupRequested = false;
  let fillerTimer = null;
  const write = (chunk) => {
    if (signal.aborted) return;
    text += chunk;
    onText(chunk);
  };
  // Each sentence is voiced separately, and TTS renders a lone "Hello!" with a different
  // pitch than the rest -- it sounds like a voice change. Hold the opening text until the
  // first sentence is complete and fold a one/two-word opener into the next one.
  let opening = "";
  let openingDone = false;
  const say = (chunk) => {
    if (openingDone) return write(chunk);
    opening += chunk;
    const match = opening.match(/^\s*(\S+(?:\s+\S+)?)[.!۔]\s+(\S)/);
    if (match) {
      opening = opening.replace(/^(\s*\S+(?:\s+\S+)?)[.!۔]\s+(\S)/, (m, words, next) => `${words}, ${next === "I" ? next : next.toLowerCase()}`);
    } else if (!/[.!?۔؟।]\s/.test(opening) && opening.length < 60) { // incl. Urdu/Arabic/Hindi ends
      return; // first sentence not finished yet
    }
    openingDone = true;
    write(opening);
  };
  const flushOpening = () => {
    if (!openingDone && opening) {
      openingDone = true;
      write(opening);
    }
  };

  try {
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const stream = await withRetry(
        generate,
        () => !text && !signal.aborted
      );
      const modelParts = [];
      const calls = [];
      let usage = null;
      try {
        for await (const chunk of stream) {
          if (chunk.usageMetadata) usage = chunk.usageMetadata;
          for (const part of chunk.candidates?.[0]?.content?.parts || []) {
            modelParts.push(part); // kept verbatim: function calls carry thought signatures
            if (part.functionCall) calls.push(part.functionCall);
            else if (part.text && !part.thought) say(part.text);
          }
        }
      } finally {
        addUsage(state, usage);
      }
      flushOpening();
      if (calls.length === 0) break;
      if (signal.aborted) break;
      // Trailing space: the filler is a finished sentence and should be voiced right away.
      if (!text && !fillerTimer && calls.some((call) => call.name !== "avr_hangup")) {
        fillerTimer = setTimeout(() => !text && !opening && write(`${TOOL_FILLER} `), FILLER_DELAY_MS);
      }

      // avr_hangup is left to index.js (after the closing line plays); other tools run now.
      const responses = [];
      for (const call of calls) {
        console.log(`[${uuid}] tool call: ${call.name}`, call.args);
        state.toolsCalled.push(call.name);
        let result;
        if (call.name === "avr_hangup") {
          hangupRequested = true;
          result = "The call will end after your closing line.";
        } else if (!declaredTools.has(call.name)) {
          // Models sometimes call a tool their instructions mention but that is disabled here.
          console.warn(`[${uuid}] refused undeclared tool ${call.name}`);
          result = `Error: ${call.name} is not available on this line.`;
        } else {
          try {
            result = await getToolHandler(call.name)(uuid, call.args || {}, {});
          } catch (error) {
            console.error(`[${uuid}] tool ${call.name} failed:`, error.message);
            result = `Error: ${error.message}`;
          }
          state.toolLog.push(`${call.name}(${JSON.stringify(call.args || {})}) -> ${typeof result === "string" ? result : JSON.stringify(result)}`);
        }
        console.log(`[${uuid}] tool result: ${call.name} ->`, result);
        responses.push({ functionResponse: { id: call.id, name: call.name, response: { result } } });
      }
      if (hangupRequested) break;
      contents.push({ role: "model", parts: modelParts });
      contents.push({ role: "user", parts: responses });
    }
  } finally {
    clearTimeout(fillerTimer);
    flushOpening();
  }
  return { text, hangupRequested };
};

/**
 * Runs the onCallEnd hook (e.g. to store the transcript or send a summary) for a finished call.
 * @param {{ uuid: string, transcript: Array<{timestamp: string, speaker: string, text: string}>,
 *   state: object, startedAt: Date, endReason: string }} call
 */
const runCallEndHook = async ({ uuid, transcript, state, startedAt, endReason }) => {
  console.log(`[${uuid}] call ended (${endReason}), ${transcript.length} transcript entries`);
  if (!hooks.onCallEnd) return;
  try {
    await hooks.onCallEnd({
      sessionUuid: uuid,
      transcript,
      stats: {
        agent: process.env.BOT_NAME || "gemini_llm",
        startedAt: startedAt.toISOString(),
        durationSeconds: Math.round((Date.now() - startedAt) / 1000),
        toolsCalled: state.toolsCalled,
        llmUsage: state.usage,
        endReason,
      },
    });
  } catch (error) {
    console.error(`[${uuid}] hooks.onCallEnd failed:`, error);
  }
};

module.exports = {
  MODEL,
  SPOKEN_CHARS_PER_SECOND,
  getToolHandler,
  newAgentState,
  runTurn,
  runCallEndHook,
};
