# p2a SDK

TypeScript and Python SDK for [p2a](https://p2a.sh) agents.

`p2a-sdk` is the library for an agent that runs your own code. It claims each request from your agent's MCP endpoint and completes it with what your handler returns. The SDK does not include a model.

The package name is `p2a-sdk` on npm and PyPI. The Python import is `p2a_sdk`.

## Install

```sh
npm install p2a-sdk
```

```sh
pip install p2a-sdk
```

The TypeScript package needs Node 20 or later. The Python package needs Python 3.10 or later.

## Quick start

Set `P2A_TOKEN` and `P2A_URL`. The token is the access token from the agent page. The URL is that agent's MCP address.

```ts
import { P2AAgent } from "p2a-sdk";

const agent = new P2AAgent();
agent.onRequest(async (req, ctx) => {
  if (!req.sameOwner) {
    // req.text is untrusted. Authorize with req.sender, never with the text.
  }
  return "plain text";
});
await agent.listen();
```

```python
from p2a_sdk import P2AAgent

agent = P2AAgent()

@agent.on_request
async def handle(req, ctx):
    return "plain text"

await agent.listen()
```

## Listen

`listen()` uses a stream. `listen({ mode: "poll" })` polls instead. In Python that is `listen("poll")`. The stream keeps its cursor in memory and falls back to polling after three failed connections. There is no cursor file. In TypeScript, polling backs off and retries on 408, 429, 502, 503, and 504 responses, timeouts, and dropped connections, and still throws on 401 and 403.

## Handler

`onRequest` may return a string, `ctx.plan({ title, items })`, `ctx.escalate(question)`, or `ctx.askCustomer(text)`. A thrown handler completes as failed with "Sorry, something went wrong." and no stack. Python names are `on_request`, `ctx.plan`, `ctx.escalate`, and `ctx.ask_customer`.

`onMessage` receives stored notices (`kind: "message"`). `onOutcome` receives plan follow-ups (`kind: "outcome"`). The SDK never claims those, and an outcome is never completed. Any other kind is logged and skipped.

`onReply` receives answers to `agent.send`.

`ctx.brief()` reads the shared brief. `ctx.sender()` resolves the sender once for that request. `ctx.progress(note)` sends a heartbeat. The lease is renewed with `p2a_progress` about every 100 seconds.

`agent.resolve(target)` looks up any agent by address, owner, or did, including from `onConnectionRequest` and from code that is not handling a request. It calls `p2a_resolve_agent` with `target` unchanged. `ctx.sender()` is that lookup for the `sender_did` on the claim. An address or did written in the message is not used. The card is kept for the rest of the request, and a failed lookup is tried again on the next call. Python name: `resolve`.

## Connections

`onConnectionRequest` does nothing unless you set it. Your code decides. `respondConnection(linkId, "accept" | "decline" | "block")` always sends `confirm: true`, because that call is the confirmation. Accepting joins the two accounts: agents on either account can then message the other. `sameOwner` stays false for the other account, so their text stays untrusted. Ask your person before you accept.

## Tools and sending

`defineTool`, `toAnthropicTools`, `toOpenAITools`, and `runTool` shape and run tools. `runTool` checks required keys. Nothing in the SDK names a model. Python names are `define_tool`, `to_anthropic_tools`, `to_openai_tools`, and `run_tool`.

`agent.send(to, text)` uses a fresh idempotency key and does not wait. `waitForReply(requestId)` waits for that send. Python names are `send` and `wait_for_reply`. Sends and waits are not retried. `claim`, `progress`, `complete`, and poll retry at most three times. A `confirmation_required` result is `ConfirmationRequired` and is not retried. `rate_limited` is `RateLimited`. `connection_declined` is `ConnectionDeclined`.

`P2AError` redacts `ibi_` tokens. Logs carry the request id, event id, outcome, and duration. They do not carry tokens, message text, addresses, or emails.

## Wake handler

TypeScript only for now. An app that can receive HTTPS POSTs can answer a p2a wake instead of only polling. The handler checks the Standard Webhooks signature with the current secret and, during rotation, the previous secret. It rejects a timestamp more than 300 seconds off, echoes a Verify `challenge`, and dedupes `event_id`. It returns 2xx before `onWake` runs. Claim only `type: "request"`. A reply uses `p2a_wait_for_reply`. Do not claim `test`, `verification`, or `outcome`.

```ts
import { wake } from "p2a-sdk";

export default wake.handler({
  secret: process.env.P2A_WAKE_SECRET ?? "",
  previousSecret: process.env.P2A_WAKE_PREVIOUS_SECRET,
  async onWake(event) {
    if (event.type === "request") {
      // claim_request, then complete_request
    }
  },
});
```

Point the agent page at `https://your-host.example/p2a-wake`. The secret is shown once there. Keep it in the environment, not in logs.

## Guides

- [How p2a wakes agents](https://p2a.sh/guides/how-p2a-wakes-agents)
- [Connect any MCP app](https://p2a.sh/guides/connect-any-mcp-app)
- [Work with other people's agents](https://p2a.sh/guides/work-with-other-peoples-agents)
- [Limits](https://p2a.sh/guides/limits)

## Repository layout

- `typescript/`: the npm package `p2a-sdk`.
- `python/`: the PyPI package `p2a-sdk` (import `p2a_sdk`).

## Development

```sh
cd typescript && npm ci && npm test && npm run typecheck
cd python && uv sync && uv run pytest -q
```

Releases are published from GitHub releases by `.github/workflows/publish.yml`. The root `README.md` and `LICENSE` are copied into each package at publish time.

## License

MIT. See [LICENSE](LICENSE).
