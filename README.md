# Agent Voice Response - Gemini LLM Integration

[![Discord](https://img.shields.io/discord/1347239846632226998?label=Discord&logo=discord)](https://discord.gg/DFTU69Hg74)
[![GitHub Repo stars](https://img.shields.io/github/stars/agentvoiceresponse/avr-llm-gemini?style=social)](https://github.com/agentvoiceresponse/avr-llm-gemini)
[![Docker Pulls](https://img.shields.io/docker/pulls/agentvoiceresponse/avr-llm-gemini?label=Docker%20Pulls&logo=docker)](https://hub.docker.com/r/agentvoiceresponse/avr-llm-gemini)
[![Ko-fi](https://img.shields.io/badge/Support%20us%20on-Ko--fi-ff5e5b.svg)](https://ko-fi.com/agentvoiceresponse)

This repository integrates **Agent Voice Response** with **Google Gemini** as the LLM of the ASR -> LLM -> TTS pipeline. It is a drop-in alternative to `avr-llm-openai` and `avr-llm-anthropic`: point avr-core's `LLM_URL` at `http://<host>:6052/prompt-stream`.

Gemini's replies are streamed sentence by sentence, function calls run in a loop (tool results go back to Gemini, so the caller hears a natural answer instead of raw tool output), and each request is given the context a phone agent needs: the current date and time, the caller ID and the results of tools used earlier in the call.

## Prerequisites

1. **Node.js** and **npm** installed.
2. A **Gemini API key** ([Google AI Studio](https://aistudio.google.com/apikey)).
3. [avr-ami](https://github.com/agentvoiceresponse/avr-ami), for the caller ID lookup and the `avr_transfer` / `avr_hangup` tools.

## Setup

### 1. Clone the Repository

```bash
git clone https://github.com/agentvoiceresponse/avr-llm-gemini.git
cd avr-llm-gemini
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Configure Environment Variables

Create a `.env` file in the root of the project (see `.env.example`):

```bash
GEMINI_API_KEY=your_gemini_api_key
PORT=6052
GEMINI_MODEL=gemini-3.5-flash
SYSTEM_PROMPT="You are a helpful assistant."
AMI_URL=http://127.0.0.1:6006
```

### 4. Running the Application

```bash
node index.js
```

The server will start on the port defined in the environment variable (default: 6052).

### 5. Docker

```yaml
avr-llm-gemini:
  image: agentvoiceresponse/avr-llm-gemini
  container_name: avr-llm-gemini
  restart: always
  environment:
    - PORT=6052
    - GEMINI_API_KEY=${GEMINI_API_KEY}
    - GEMINI_MODEL=gemini-3.5-flash
    - SYSTEM_PROMPT_FILE=/usr/src/app/instructions.txt
    - AMI_URL=http://avr-ami:6006
  volumes:
    - ./instructions.txt:/usr/src/app/instructions.txt:ro
    - ./tools:/usr/src/app/tools:ro
```

In avr-core, set `LLM_URL=http://avr-llm-gemini:6052/prompt-stream` and, to end calls promptly, `WEBHOOK_URL=http://avr-llm-gemini:6052/webhook`.

## How It Works

- **Express.js Server**: receives avr-core's requests and streams Gemini's reply back as it is generated.
- **Gemini API Integration**: uses the `@google/genai` SDK with streaming and function calling.
- **Tool Integration**: tools are loaded from `avr_tools` (built in) and `tools` (your own). Tool results go back to Gemini, which then answers the caller.
- **Per-call context**: each request tells the model:
  - the **current date and time** in `CALL_TIMEZONE`. Models have no clock; without this, "tomorrow" is resolved to a date in their training period.
  - the **caller ID**, from avr-ami `/variables` (looked up once per call). The dialplan must set these before handing the call to avr-core:

    ```
    same => n,Set(AVR_CALLER_NUM=${CALLERID(num)})
    same => n,Set(AVR_CALLER_NAME=${CALLERID(name)})
    ```

    A caller ID name that is empty or just a number is ignored, and the model is told to confirm the name before using it.
  - the **results of tools used earlier in the call**. avr-core's history only carries spoken text, so results (slots, ids, errors) are kept per call and dropped after 30 minutes of inactivity.
- **Hangup**: `avr_hangup` is delayed until the closing line has roughly been spoken (estimated from its length), and cancelled if the caller speaks again.
- **Interruptions**: a newer caller turn cancels a reply still in progress, and when the caller talked over the previous reply, the model is told which part they probably heard.
- **Context caching** (optional): with `GEMINI_CACHE_TTL_SECONDS`, the system prompt and tool declarations are stored in a Gemini context cache, which lowers the cost and latency of long prompts.
- **Web search** (optional): `GEMINI_WEB_SEARCH=true` adds Google Search grounding alongside the function tools.

## API Endpoints

### POST /prompt-stream

**Request:**

```json
{
  "uuid": "call-uuid",
  "messages": [
    { "role": "system", "content": "..." },
    { "role": "user", "content": "Hello" }
  ]
}
```

**Response:** a stream of JSON objects, one per write:

```json
{ "type": "text", "content": "Hi, how can I help you today?" }
```

### POST /webhook

avr-core's `WEBHOOK_URL`. Only `call_ended` is used: it ends the call's state and runs the `onCallEnd` hook right away. Without it, a call is considered over after 2 minutes without a request.

## Customizing the Application

### Environment Variables

- `GEMINI_API_KEY`: Your Gemini API key (required; `GOOGLE_API_KEY` also works)
- `PORT`: The port on which the server will listen (default: 6052)
- `HOST`: The address to listen on (default: 0.0.0.0)
- `GEMINI_MODEL`: The Gemini model to use (default: gemini-3.5-flash)
- `GEMINI_TEMPERATURE`: Controls randomness in responses (default: 0.3)
- `GEMINI_MAX_TOKENS`: Maximum length of a response (default: 300)
- `GEMINI_THINKING_LEVEL`: Gemini's thinking level (default: minimal, for the lowest latency)
- `GEMINI_CACHE_TTL_SECONDS`: Enables context caching with this TTL in seconds (default: 0, off)
- `GEMINI_WEB_SEARCH`: `true` adds Google Search grounding (default: false; adds about 2 s on turns that search)
- `SYSTEM_PROMPT_FILE`: A file with the system prompt (optional)
- `SYSTEM_PROMPT`: The system prompt, or extra notes appended to `SYSTEM_PROMPT_FILE` when both are set (default: "You are a helpful assistant.")
- `CALL_TIMEZONE`: Time zone of the date and time given to the model (default: UTC)
- `AMI_URL`: URL of avr-ami, for the caller ID and the transfer/hangup tools (default: http://127.0.0.1:6006)
- `DISABLED_TOOLS`: Comma-separated tool names to leave out, e.g. when several agents share one `tools` directory (optional)
- `SUPPORT_EMAIL`: If set, a caller whose email address still isn't right after two read-backs is asked to email this address instead (optional)
- `AVR_HOOKS_PATH`: Path of the hooks module (default: `./hooks`, optional)
- `BOT_NAME`: Agent name passed to the `onCallEnd` hook (default: gemini_llm)

### Adding Custom Tools

To add custom tools, create a file in the `tools` directory (or mount one at `/usr/src/app/tools`):

```javascript
module.exports = {
  name: "get_weather",
  description: "Gets the current weather for a city.",
  input_schema: {
    type: "object",
    properties: {
      city: { type: "string", description: "The city name" },
    },
    required: ["city"],
  },
  handler: async (uuid, { city }) => {
    return `The weather in ${city} is sunny.`;
  },
};
```

Use snake_case tool names. A tool's return value goes back to Gemini, which phrases the answer for the caller.

### Hooks

An optional module at `AVR_HOOKS_PATH` can export `onCallEnd`, which runs once per call when it ends:

```javascript
module.exports = {
  onCallEnd: async ({ sessionUuid, transcript, stats }) => {
    // transcript: [{ timestamp, speaker: "Caller" | "AI", text }]
    // stats: { agent, startedAt, durationSeconds, toolsCalled, llmUsage, endReason }
  },
};
```

For example, to store the transcript or email a summary. `llmUsage` holds Gemini's token counts for the call (requests, input, cached and output tokens).

## Error Handling

- Missing `uuid` or `messages` returns 400.
- A temporary Gemini error (429, 500, 503) is retried once if nothing has been said yet; if the request still fails, the caller hears a short apology.
- Tool errors are returned to Gemini, which tells the caller.

All errors are logged to the console.

## Support & Community

*   **Website:** [https://agentvoiceresponse.com](https://agentvoiceresponse.com) - Official website.
*   **GitHub:** [https://github.com/agentvoiceresponse](https://github.com/agentvoiceresponse) - Report issues, contribute code.
*   **Discord:** [https://discord.gg/DFTU69Hg74](https://discord.gg/DFTU69Hg74) - Join the community discussion.
*   **Docker Hub:** [https://hub.docker.com/u/agentvoiceresponse](https://hub.docker.com/u/agentvoiceresponse) - Find Docker images.
*   **NPM:** [https://www.npmjs.com/~agentvoiceresponse](https://www.npmjs.com/~agentvoiceresponse) - Browse our packages.
*   **Wiki:** [https://wiki.agentvoiceresponse.com/en/home](https://wiki.agentvoiceresponse.com/en/home) - Project documentation and guides.

## Support AVR

AVR is free and open-source.
Any support is entirely voluntary and intended as a personal gesture of appreciation.
Donations do not provide access to features, services, or special benefits, and the project remains fully available regardless of donations.

<a href="https://ko-fi.com/agentvoiceresponse" target="_blank"><img src="https://ko-fi.com/img/githubbutton_sm.svg" alt="Support us on Ko-fi"></a>

## License

MIT License - see the [LICENSE](LICENSE) file for details.
