/**
 * index.js
 * Gemini LLM service for Agent Voice Response (ASR -> LLM -> TTS pipeline). The agent
 * itself (prompt, tools, per-call context, tool loop) lives in agent.js.
 *
 * Same contract as avr-llm-openai / avr-llm-anthropic, so avr-core can use it via LLM_URL:
 *   POST /prompt-stream  { uuid, messages: [{ role: "system"|"user"|"assistant", content }] }
 *   -> stream of JSON objects {"type":"text","content":"..."}, one per write, then end.
 *
 * When the call ends, the optional onCallEnd hook runs (AVR_HOOKS_PATH) with the transcript
 * and token usage. The end comes from avr-core's call_ended webhook (point WEBHOOK_URL at
 * /webhook), or after CALL_END_IDLE_MS without a request as a fallback.
 *
 * Turn-taking gaps in avr-core 1.13 this service compensates for (measured):
 *  - a new transcript while a reply is still in progress starts a second request without
 *    cancelling the first, so both replies play. A newer turn here cancels the older one.
 *  - when the caller talks over a reply, playback stops but the history still holds the
 *    whole reply. The model is told when its last reply was probably cut off.
 *
 * @author Agent Voice Response <info@agentvoiceresponse.com>
 * @author Zohair Raza <https://github.com/zohairraza>
 * @see https://www.agentvoiceresponse.com
 */
const express = require("express");
const { MODEL, SPOKEN_CHARS_PER_SECOND, getToolHandler, newAgentState, runTurn, runCallEndHook } = require("./agent");

const HANGUP_MARGIN_MS = 1500;
const CALL_STATE_TTL_MS = 30 * 60 * 1000;
// Longer than any gap between turns of a live call: IDLE_HANGUP_TIMEOUT_SECONDS plus the longest reply.
const CALL_END_IDLE_MS = 2 * 60 * 1000;
// Interruption estimate: playback starts about TTS_LEAD_MS after the first sentence is sent,
// and the caller started talking about CALLER_SPEECH_MS before their transcript arrives.
const TTS_LEAD_MS = 700;
const CALLER_SPEECH_MS = 1000;

/**
 * Per-call state, keyed by avr-core's uuid: the agent state (caller info, tool results),
 * whether a hangup is already pending, and the transcript so far.
 * Ended (onCallEnd) after CALL_END_IDLE_MS without a request; dropped after CALL_STATE_TTL_MS.
 */
const callStates = new Map();
const getCallState = (uuid) => {
  let state = callStates.get(uuid);
  if (!state) {
    state = {
      ...newAgentState(), hangupTimer: null, startedAt: new Date(),
      transcript: [], loggedMessages: 0, lastReply: null, endTimer: null, ended: false,
    };
    callStates.set(uuid, state);
  }
  state.lastSeen = Date.now();
  clearTimeout(state.endTimer);
  state.endTimer = setTimeout(() => endCall(uuid, "caller_hangup"), CALL_END_IDLE_MS);
  return state;
};
setInterval(() => {
  const cutoff = Date.now() - CALL_STATE_TTL_MS;
  for (const [uuid, state] of callStates) if (state.lastSeen < cutoff) callStates.delete(uuid);
}, 60000).unref();

/**
 * Adds what was said since the last request to the call transcript. avr-core's message
 * history is the record of what was actually spoken (greeting, idle prompts, replies).
 */
const logMessages = (state, messages) => {
  const spoken = messages.filter((m) => m.role !== "system" && m.content);
  const timestamp = new Date().toISOString();
  for (const { role, content } of spoken.slice(state.loggedMessages)) {
    // A reply is logged with the time it was given, not when the next request arrived.
    const at = role === "assistant" && state.lastReply ? state.lastReply.timestamp : timestamp;
    state.transcript.push({ timestamp: at, speaker: role === "assistant" ? "AI" : "Caller", text: content });
    if (role === "assistant") state.lastReply = null;
  }
  state.loggedMessages = spoken.length;
};

/** Runs the onCallEnd hook once per call, with the transcript including the final reply. */
const endCall = async (uuid, endReason) => {
  const state = callStates.get(uuid);
  if (!state || state.ended) return;
  state.ended = true;
  clearTimeout(state.endTimer);
  callStates.delete(uuid);
  // The last reply never comes back in a later request's history.
  if (state.lastReply) state.transcript.push({ ...state.lastReply, speaker: "AI" });
  await runCallEndHook({ uuid, transcript: state.transcript, state, startedAt: state.startedAt, endReason });
};

/**
 * If the caller's new turn arrived before the previous reply could have finished playing,
 * avr-core stopped it mid-way, though its history shows it as fully spoken. Returns a note
 * with the estimated part they heard, or null.
 */
const interruptionNote = (reply) => {
  if (!reply) return null;
  const playedMs = Date.now() - reply.firstWriteAt - TTS_LEAD_MS - CALLER_SPEECH_MS;
  const heardChars = Math.max(0, (playedMs / 1000) * SPOKEN_CHARS_PER_SECOND);
  if (heardChars >= reply.text.length * 0.9) return null;
  const heard = reply.text.slice(0, heardChars).replace(/\s*\S*$/, "").trim();
  return (
    "The caller started talking before your previous reply finished playing, which cut it off. " +
    (heard ? `They probably heard only up to: "${heard}..."` : "They probably heard none of it.") +
    " Respond to what they just said; then, if the part they missed matters (a confirmation, a date or time, a question you asked), say it again briefly. Don't repeat what they already heard."
  );
};

/**
 * Handles one caller turn: streams Gemini's reply to avr-core, running tools as requested.
 */
const handlePromptStream = async (req, res) => {
  const { uuid, messages } = req.body || {};
  if (!Array.isArray(messages)) return res.status(400).json({ message: "Messages is required" });
  if (!uuid) return res.status(400).json({ message: "UUID is required" });

  const state = getCallState(uuid);
  // A newer caller turn supersedes a reply still in progress (avr-core would play both).
  // This request's history already has the full turn, and whatever the older one said.
  const previous = state.active;
  const abort = new AbortController();
  let finished;
  state.active = { abort, done: new Promise((resolve) => (finished = resolve)) };
  if (previous) {
    console.log(`[${uuid}] newer turn arrived, cancelling the reply in progress`);
    previous.abort.abort();
    await previous.done; // a running tool completes first, so its result is in toolLog
  }
  // A new caller turn means they're still talking: drop any hangup scheduled after the
  // previous reply (e.g. the model took a stray "no" as "not interested"). If the call
  // really is over, the model invokes avr_hangup again in this turn.
  if (state.hangupTimer) {
    clearTimeout(state.hangupTimer);
    state.hangupTimer = null;
    console.log(`[${uuid}] caller spoke again, pending hangup cancelled`);
  }
  // A superseded reply wasn't cut off by speech: avr-core plays whatever it already got.
  const cutOff = previous ? null : interruptionNote(state.lastReply);
  if (cutOff) console.log(`[${uuid}] previous reply was probably cut off`);
  logMessages(state, messages);
  // Stop generating (and billing) if avr-core drops the request.
  res.on("close", () => abort.abort());

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  let spokenText = "";
  let firstWriteAt = null;
  let hangupRequested = false;
  const write = (text) => {
    if (abort.signal.aborted) return;
    firstWriteAt ??= Date.now();
    spokenText += text;
    res.write(JSON.stringify({ type: "text", content: text }));
  };

  try {
    ({ hangupRequested } = await runTurn({ uuid, state, messages, notes: [cutOff], signal: abort.signal, onText: write }));
  } catch (error) {
    if (abort.signal.aborted) console.log(`[${uuid}] request cancelled`);
    else {
      console.error(`[${uuid}] Gemini request failed:`, error.message);
      if (!spokenText) write("Sorry, I'm having a technical problem. Could you repeat that?");
    }
  }
  if (!res.writableEnded) res.end();
  if (spokenText) state.lastReply = { timestamp: new Date(firstWriteAt).toISOString(), firstWriteAt, text: spokenText };
  if (state.active?.abort === abort) state.active = null;
  finished();

  if (hangupRequested && !abort.signal.aborted && !state.hangupTimer) {
    const delayMs = (spokenText.length / SPOKEN_CHARS_PER_SECOND) * 1000 + HANGUP_MARGIN_MS;
    console.log(`[${uuid}] hanging up in ${Math.round(delayMs)}ms`);
    state.hangupTimer = setTimeout(() => {
      state.hangupTimer = null;
      state.agentHungUp = true;
      getToolHandler("avr_hangup")(uuid, {}, {}).catch((e) => console.error(`[${uuid}] hangup failed:`, e.message));
    }, delayMs);
  }
};

const app = express();
app.use(express.json({ limit: "1mb" }));
app.post("/prompt-stream", handlePromptStream);
// avr-core WEBHOOK_URL: only call_ended is used, to run onCallEnd as soon as the call is over.
app.post("/webhook", (req, res) => {
  const { uuid, type } = req.body || {};
  res.sendStatus(200);
  if (type === "call_ended" && uuid) {
    endCall(uuid, callStates.get(uuid)?.agentHungUp ? "agent_hangup" : "caller_hangup");
  }
});

const port = process.env.PORT || 6052;
// HOST: listen on one address only (e.g. 127.0.0.1 when avr-core runs on the same host).
const host = process.env.HOST || "0.0.0.0";
app.listen(port, host, () => console.log(`Gemini LLM service (${MODEL}) listening on ${host}:${port}`));
