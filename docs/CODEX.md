# Codex with Conduit

Verified using **Codex CLI 0.155.1** and the current Copilot model API, with
additional Astra max-effort/search/context-budget verification on **2026-09-21**.
This guide distinguishes native protocol support from hosted services that
Copilot does not provide.

## Recommended setup

Start Conduit with a non-empty `CONDUIT_API_KEY`, then run from the repository:

```bash
./bin/conduit-codex
./bin/conduit-codex --help
```

The helper reads the environment key or repository `.conduit-key`, obtains
model metadata, writes a local catalog, and applies provider overrides for
this invocation. Your existing Codex configuration and login remain intact.
Normal Codex sandbox and approval controls remain in force.

The ordinary `/v1/models` response is still an OpenAI model list. Codex needs
the different `ModelInfo` shape returned by
`/v1/models?client_version=0.155.1`. The catalog uses Copilot's declared prompt
and context limits rather than Codex's generic unknown-model fallback. It
disables Responses Lite and does not advertise unverified hosted tools.

Explicitly choosing a model unavailable in the catalog is an error, not
permission to silently select another model. Chat-only models remain usable
through `/v1/chat/completions`, but are not advertised as native Codex models.

## Manual provider configuration

For the optional short command, see [the `cx` preset](#short-command-cx).

For a manually managed setup, use a user-level Codex configuration like:

```toml
model = "gpt-6-astra" # This model has live-verified reasoning summaries.
model_provider = "conduit"
model_reasoning_summary = "detailed"
hide_agent_reasoning = false
web_search = "disabled"
model_catalog_json = "/absolute/path/to/conduit-models.json"

[model_providers.conduit]
name = "Conduit"
base_url = "http://127.0.0.1:7133/v1"
wire_api = "responses"
env_key = "CONDUIT_API_KEY"
requires_openai_auth = false
supports_websockets = false
supports_standalone_web_search = false
```

Export `CONDUIT_API_KEY` before starting Codex. The catalog file must contain
the authenticated Codex catalog response, not the normal OpenAI model list.
The helper is preferred because it generates the catalog and configuration
together.

Select a model explicitly, or forward normal Codex arguments after `--`:

```bash
./bin/conduit-codex --model gpt-6-astra
./bin/conduit-codex --model gpt-5.4-mini -- exec "Explain this project"
```

`CONDUIT_CODEX_BASE_URL`, `CONDUIT_CODEX_MODEL`, `CONDUIT_CODEX_CACHE_DIR` and
`CODEX_BIN` configure the launcher. The default cache is the checkout's ignored
`data/codex` directory, with private directory/file permissions. The key file
may contain either a raw key or a `CONDUIT_API_KEY=...` assignment; it is parsed
as data, never sourced as a shell script.

## Short command: `cx`

`bin/cx` is an explicit opt-in shortcut for the previously described
**Astra / max / detailed reasoning summaries / 872,000 usable tokens / live search /
no sandbox / no standard execution approvals** combination:

```bash
./bin/cx
./bin/cx exec "Explain this project"
./bin/cx --help
```

To install it on your PATH once, run from this checkout:

```bash
mkdir -p "$HOME/.local/bin"
ln -s "$PWD/bin/cx" "$HOME/.local/bin/cx"
```

The link command deliberately does not overwrite an existing command. Ensure
`$HOME/.local/bin` is on your shell's PATH. Then, from the project you want to
work on:

```bash
cx
```

The proxy must already be running. The shortcut preserves the current working
directory and forwards extra Codex arguments without shell evaluation. It
does not replace the original `codex` command or edit login/configuration files.
Model and context selection are fixed by this preset; use `conduit-codex` for
different settings. Explicit extra Codex configuration can override defaults
such as reasoning or search.

**Permission warning:** this preset intentionally passes
`--dangerously-bypass-approvals-and-sandbox`. Only use it in trusted projects.
It does not grant root access or bypass independent OS, organization, hook or
MCP permissions. The ordinary `conduit-codex` entry point retains its safer
default behavior.

## Provider configuration notes

Important:

- `wire_api = "chat"` is no longer supported by this Codex release.
- Use the API root ending in `/v1`, not a URL already ending in `/responses`.
- Do not name this provider `OpenAI`: Codex uses first-party provider identity
  for behavior such as remote compaction.
- Do not copy prerelease-only settings into a stable Codex configuration.
- An API key for OpenAI is not required. A Copilot-enabled account and the
  separate local Conduit key are required.

## Official desktop GUI through Conduit (macOS)

**Verified on 2026-09-21:** official ChatGPT desktop **26.915.31945**, signed by
OpenAI OpCo, LLC (`2DC432GLL2`), with bundled Codex app-server
`0.155.0-alpha.9.2`. Both the **Codex** developer view and **ChatGPT Work**
local view sent real requests through Conduit and displayed model replies.
Native web search was also exercised from the Work GUI.

```bash
# Official client, if it is not installed:
brew install --cask chatgpt

# From this checkout:
./bin/cxg
```

Optionally install the short command without replacing an existing command:

```bash
ln -s "$PWD/bin/cxg" "$HOME/.local/bin/cxg"
cxg
```

The proxy must already be running and the checkout's `.conduit-key` must match
the proxy key. `cxg` launches the **unmodified official app**, not a replacement
web chat. Select **ChatGPT Work** for local general work or **Codex** for the
developer interface. Ordinary questions can also be asked in the Work view.

### Isolation, credentials and permissions

The launcher keeps its state separate:

| Location | Purpose |
|---|---|
| `~/.codex-conduit-gui` | Dedicated model catalog, provider configuration and local sessions |
| `~/Library/Application Support/Conduit ChatGPT` | Dedicated GUI preferences/browser state |
| Checkout `.conduit-key` | Existing Conduit client key; not copied into config |

The model provider uses Codex's supported command-backed authentication.
`bin/conduit-auth-token --stdio-token` reads the key as data and supplies it
only through the backend's private stdout pipe. The GUI configuration contains
the helper path, not the key. This also works when Finder does not inherit
terminal environment variables.

Existing personal Codex configuration, login and GUI state are not replaced.
Existing settings in the dedicated managed profile, including user-added MCP
configuration, are preserved on subsequent launches. Unmanaged or conflicting
profile directories are rejected, not silently overwritten.

New GUI profiles default to Astra, max reasoning, detailed reasoning summaries,
872,000 usable context tokens and live search, with **on-request approvals and
workspace-write sandboxing**. This is
deliberately different from the unrestricted `cx` preset. The launcher does
not grant Accessibility, Screen Recording or other OS permissions.

New profiles also enable the desktop's separate **Max** reasoning option
using `desktop.enabled-reasoning-efforts` in the dedicated `config.toml`.
In desktop 26.915.31945, setting only `model_reasoning_effort="max"` and the
catalog default is insufficient: if Max is hidden by desktop preferences,
the app can write the default back to `medium` on startup.

For an older dedicated profile, quit the app and back up its `config.toml`.
Set the top-level `model_reasoning_effort="max"` and add `"max"` to the
existing `desktop.enabled-reasoning-efforts` array. If the preference is
absent, the tested default plus Max is:

```toml
[desktop]
enabled-reasoning-efforts = ["low", "medium", "high", "xhigh", "max", "ultra", "persistent"]
```

Merge into an existing `[desktop]` table rather than duplicating it, preserve
other settings and levels, then reopen with `cxg`. The launcher preserves
existing profiles; it does not silently undo an intentionally lower effort.

Environment overrides: `CONDUIT_GUI_APP_PATH`, `CONDUIT_GUI_HOME`,
`CONDUIT_GUI_DATA_DIR`, and `CONDUIT_CODEX_BASE_URL`. Use dedicated directories;
do not point the GUI profile at your existing `~/.codex`.

### Verified behavior and current UI caveats

- The GUI's Work conversation was matched to an HTTP 200 Conduit
  `/v1/responses` request, with `model_provider=conduit` and originator
  `codex_work_desktop`. The Codex view was independently exercised.
- Actual GUI session records confirmed `gpt-6-astra`, effort **max** and a
  usable context window of **872000**.
- The Work GUI performed native `web_search_call` search/open-page actions
  and displayed the official source URL.
- In desktop 26.915.31945, a profile without the separate Max option may show
  **Medium / 中** even while an existing thread still uses **max**, and may
  reset the default for new threads to medium. Enable Max as described above;
  verify the actual new-thread settings rather than trusting an older thread.
  Manually moving the intensity control can still select a lower effort.
- After enabling that option and restarting, the GUI displayed **6 Astra 最高**
  and a newly created Work conversation independently confirmed provider
  `conduit`, Astra, **max**, and **872000** usable context tokens.
- The current custom-provider interface presents **ChatGPT Work** and
  **Codex**. This setup does not reroute hosted ChatGPT Chat, web/cloud Work,
  account-managed connectors, or cloud-only features through Copilot.
- Desktop Computer Use passed the scoped native-app test below. Other apps,
  plugins and workflows still need their own permissions and verification;
  text or web-search success alone does not establish their support.

### `@Computer`: setup and current verification boundary

The desktop plugin is **not** the hosted Responses `computer` /
`computer_use_preview` tool rejected in the earlier API probes. The official
local plugin calls a native helper through `cua_repl` and can request access to
individual apps.

In **Plugins > Computer Use**, install/enable the plugin and its skill, then
use **Try now** or mention `@Computer`. In the current desktop build the
managed unified `cua_repl` path is used; an older direct `computer-use` MCP
entry can be disabled by the app during startup and is not the authoritative
indicator for that unified path. Then follow the
normal macOS permission flow for **Codex Computer Use / ChatGPT Computer Use**:

1. Enable **Accessibility** in System Settings > Privacy & Security.
2. Enable **Screen Recording / Screen & System Audio Recording** for the same
   helper. Follow any system request to quit and reopen it.
3. Approve only the target application when the Work conversation asks.

These system permissions are separate from the in-chat app approval and from
Codex's shell sandbox. Do not edit TCC databases, disable OS protections, or
grant every application access as a workaround.

**The full local computer-operation loop passed on 2026-09-21**, after the
user granted the macOS permissions and the app was reopened. The test used
official ChatGPT **26.915.31945**, its bundled Codex
**0.155.0-alpha.9.2**, and the local Work view through Conduit. Actual session
records confirmed **gpt-6-astra / max / 872000 usable context tokens**.

Only a generated, harmless native Cocoa window, **Conduit UI Probe**, was
approved for the current conversation. The real `mcp__cua_repl` calls:

1. Reset the JS session and acquired that specific app.
2. Read its accessibility state and screenshot to obtain the visible code;
   the prompt did not contain that code.
3. Clicked the input, typed the observed code, and clicked **Verify**.
4. Read the resulting accessibility state and took a confirmation screenshot.

The session returned **two images**, completed without a tool error, and the
test app independently wrote a fresh `COMPUTER_GUI_NATIVE_VERIFIED` marker
only after its Verify handler accepted the input. The marker was created
after this test turn began. No other app, personal browser profile, fixture
source read, or shell/AppleScript shortcut was used to complete the task.
This verifies a scoped native-app workflow, not every application or action.

Earlier attempts encountered helper startup failures, a separate legacy
relative-path `ENOENT`, and pending macOS permissions. After permission was
granted, an older generated AppleScript dialog also timed out; that attempt
is **not** counted as a pass. The successful retest used a standard Cocoa
window and the official app-managed plugin, without patching OpenAI binaries
or translating hosted `computer` calls into a fake executor.

The app regenerates its legacy compatibility entry during startup. **Do not
repeatedly force that disabled entry on as a fix for macOS permissions.**
If deliberately using the legacy direct MCP path and encountering `ENOENT`,
verify the installed helper before configuring absolute paths:

```toml
[mcp_servers.computer-use]
command = "/Users/YOU/.codex-conduit-gui/computer-use/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient"
args = ["mcp"]
cwd = "/Users/YOU/.codex-conduit-gui/computer-use"
enabled = true
```

The verified GUI route uses the app-managed plugin, not a custom replacement
for native Computer Use. Preserve other plugin configuration and back up the
dedicated config before manual changes. See
[OpenAI's Computer Use setup and approval guide](https://learn.chatgpt.com/docs/computer-use).

### How the GUI was operated during validation

Temporary Playwright automation connected to the desktop app's internal
Chromium UI using the Chrome DevTools Protocol (CDP), listening only on
`127.0.0.1`. It selected Work/Codex, entered prompts and handled the test-app
approval. This is app-internal UI automation, not a system-wide remote
desktop connection.

The native fixture was **not** operated through CDP. Its observations, input
and clicks came from the official Computer Use helper, with macOS permissions
and per-app approval. Those tool results and the independent fixture marker,
not the model's success message alone, establish the pass.

Normal `cxg` launches **do not enable a debugging port**. The temporary
inspection instance was closed and the app relaunched normally after testing.
Using the stock app icon directly may select its ordinary profile; use `cxg`
(or your dedicated Conduit GUI shortcut) for this isolated route.

Official references:
[custom providers](https://learn.chatgpt.com/docs/config-file/config-advanced#custom-model-providers),
[authentication](https://learn.chatgpt.com/docs/auth#alternative-model-providers),
[local Work/external-provider boundaries](https://learn.chatgpt.com/docs/amazon-bedrock).

<a id="a-web-study-entry-is-not-automatically-a-local-plugin"></a>

### Study Mode and local guided learning

**ChatGPT's built-in Study Mode is not an installable learning plugin.**
The [official guide](https://help.openai.com/en/articles/11780217-using-study-mode-in-chatgpt)
confirms that on the web you type `@study` and **select Study** from the
suggestions, or open [chatgpt.com/studymode](https://chatgpt.com/studymode).
Use a signed-in, regular ChatGPT conversation: the guide excludes Temporary
Chats, GPTs and Projects, and lists web, iOS and Android availability.

This Conduit profile runs **local Work/Codex with an external model provider**,
not hosted ChatGPT Chat. A missing Study selector here is not a missing
Computer Use permission or a plugin that needs installing. Forwarding
Responses does not itself supply the hosted Chat mode or its account access.
No supported switch for enabling the official mode in this provider profile
has been verified. The official web route uses your ChatGPT account and
limits, not the Copilot inference route.

For guided learning while keeping Conduit/Copilot, install the separate,
original **Study (Conduit local)** workflow once:

```bash
./bin/cxg --install-study
```

Then in a new **Work** conversation:

1. Type `@study` and select **Study (Conduit local)**. Typing the search text
   alone is not the same as selecting the skill.
2. Describe the topic, what you already know, and what you want to practice.
3. Answer its question, request a hint, ask for a quiz, or change the pace.
4. Say you want to leave study mode, or start a new conversation without the
   skill, to return to ordinary assistance.

The local workflow uses the currently selected model and existing Conduit
credentials. It guides one step at a time, checks attempts, gives focused
feedback, and supports quizzes and review. It is **not** OpenAI's hosted Study
Mode, does not copy its private instructions, and does not claim its widgets,
cloud memory, progress synchronization or account entitlements.

**Live verification:** on 2026-09-21, the official desktop's actual mention
picker selected this skill and its instructions reached the runtime. A
six-turn Work conversation verified step-by-step hints without a premature
solution, correction of an intentionally wrong arithmetic step, confirmation
of the learner's solution, one quiz without its answer, and an explicit exit
back to an ordinary exact-text response. All six turns used
**Conduit / Astra / max / 872000 usable context**, with no model tool calls.
This is a bounded tutoring smoke test, not a claim of official-mode parity or
teaching quality across every subject.

Installation uses the official
[local skill format and symlink discovery](https://learn.chatgpt.com/docs/build-skills).
It links this checkout's `skills/conduit-study` into
`~/.codex-conduit-gui/skills/conduit-study` (or the dedicated
`CONDUIT_GUI_HOME`), refusing to replace another skill or follow a symlinked
destination directory. Keep the checkout available; updates to its skill
files are reflected through that link. The skill is explicit-only and has no
MCP server, hooks or dependency installation. Ordinary `cxg` launches,
personal Codex settings, model selection and approvals are unchanged.

To disable it, use the desktop's skill controls. To remove it, unlink only
the installed `conduit-study` link, not the source directory or other skills.

## Visible reasoning summaries

Astra advertises `supports_reasoning_summary_parameter: true` in the Codex
catalog and defaults to `model_reasoning_summary="detailed"`. The launcher uses
that model-specific default instead of forcing every model to `none`; `cx`
explicitly selects detailed summaries and `hide_agent_reasoning=false`.
Models without verified summary support retain `none`.

Summary selection is separate from reasoning effort. A real Astra `max`
request with `summary: "auto"` returned reasoning usage but no readable summary,
whereas `concise` returned `response.reasoning_summary_text.delta` events.
These are provider-supplied summaries, not the complete private reasoning or
decrypted reasoning history. They may arrive in bursts rather than token by token.

The helper accepts explicit `auto`, `concise`, `detailed`, or `none` overrides
for summary-capable models. Non-none overrides fail clearly when the current
proxy catalog does not advertise support, rather than silently being omitted.
These are the four selections in
[Codex 0.155.1's configuration schema](https://github.com/openai/codex/blob/be2951ea34f0d295ed0becf97079f92fa5f6950e/codex-rs/core/config.schema.json):

| Value | Requested output |
|---|---|
| `none` | No reasoning summary; does not disable reasoning effort |
| `auto` | Let the upstream decide; a response may have no visible summary |
| `concise` | A short reasoning summary |
| `detailed` | A more detailed reasoning summary; the default for Astra |

Both `concise` and `detailed` have returned streamed Astra summaries in live
Responses checks. Detailed mode was echoed upstream and returned 2,254 summary
characters on a synthetic coding task; a separate arithmetic request returned
no summary. **No mode guarantees a summary on every response or a fixed length.**
There is no `full` or `all` setting exposing complete internal reasoning.
This enumeration is for Codex. The bundled Copilot SDK's `reasoningSummary`
type explicitly lists `none`, `concise`, and `detailed`; omitting that SDK
field results in automatic upstream summary selection.

This default is confined to the Codex catalog and launchers. The general
`/v1/responses` route still forwards caller-supplied `auto`, `concise`,
`detailed`, `none`, omitted reasoning, and `reasoning: null` without rewriting
them. Other models, Chat Completions, Messages, authentication, reasoning
effort, context limits, and sandbox/approval settings are not changed by the
summary default. An explicit `cx` summary/display override still takes
precedence over the preset.

```bash
./bin/conduit-codex --model gpt-6-astra -- \
  -c 'model_reasoning_summary="detailed"' -c 'hide_agent_reasoning=false'

# Shorter summaries remain an explicit option:
cx -c 'model_reasoning_summary="concise"'

# Explicit opt-out; also works after the cx preset:
cx -c 'model_reasoning_summary="none"'
```

Restart a proxy that is not watching source changes, then start a new Codex
invocation to refresh its catalog. A previously running CLI session does not
automatically acquire new settings. For plain `codex` without the launcher,
set the same summary/display options in its own configuration and point
`model_catalog_json` at the refreshed Conduit catalog.
Existing `cxg` managed profiles are preserved on relaunch; set
`model_reasoning_summary="detailed"` in their own configuration when upgrading
an older profile. Refresh its catalog with `cxg` and start a new GUI session.

### VS Code Copilot SDK sessions are a separate entry point

These Codex settings do not configure VS Code's built-in Copilot SDK agent.
The inspected VS Code 1.138.0 build applies its explicit `concise` summary
option only to GPT-5.6 models, not Astra. Its session model-switch interface
also forwards effort and context tier without forwarding `reasoningSummary`.
Turning on that build's existing summary switch or opening another Astra chat
therefore does not fix this omission.

Astra and the bundled SDK can stream concise summaries when explicitly
requested; this is a host integration limitation, not a lack of model support.
The local installation was left unchanged: modifying its sealed JavaScript
resources would invalidate the app's signature, and an already-running shared
agent host would not pick up the change. Use the verified CLI path above until
the VS Code host provides an appropriate summary setting for Astra.

## Astra: max effort, live search and an exact 872k client budget

```bash
./bin/conduit-codex --model gpt-6-astra --context-budget 872000 -- \
  -c 'model_reasoning_effort="max"' \
  -c 'web_search="live"'
```

The three settings are independent. A sandbox/approval bypass does not select
max reasoning, enable search or choose a context window.

- `model_reasoning_effort="max"` was observed in the actual Codex request and
  echoed as `reasoning.effort: "max"` by Copilot.
- Native Astra search returned real `web_search_call` search/open-page items
  and URL citations, through both `/responses` and Codex CLI.
- `--context-budget 872000` sets the selected model's **usable client input
  budget** to exactly 872,000 tokens. An actual Codex `token_count` event
  confirmed `model_context_window: 872000`.
- Automatic compaction starts at 784,800 tokens (90%). This is not a claim
  that the model will wait until the entire window is full before compacting.
- The option rejects budgets below 4,096 or above the current advertised input
  limit. It saves a separate private catalog, leaves other model entries and
  the default catalog unchanged, and does not edit your user configuration.

**Why not just `-c model_context_window=872000`?** Codex normally multiplies the
catalog window by its `effective_context_window_percent`, which defaults to
95. That combination would expose only **828,400** usable tokens. The explicit
budget option marks the value as already reserved (`effective...=100`) and
sets matching CLI window/compaction overrides, so a pre-existing user setting
does not silently replace it. Do not combine the option with separate
`model_context_window` or `model_auto_compact_token_limit` overrides.

### Copilot limits are not a named 872k HTTP tier

The live Astra metadata inspected on 2026-09-21 advertised:

| Upstream field | Tokens |
|---|---:|
| `max_context_window_tokens` | 1,178,000 |
| `max_prompt_tokens` | 1,050,000 |
| `max_output_tokens` | 128,000 |

It advertised `max` reasoning, but **not a named 872k Responses tier**.
Without an explicit budget, Conduit derives a 1,050,000-token catalog input
window from those limits; Codex then applies its normal 95% usable factor.
Reasoning defaults to the catalog's medium level unless user configuration or
an explicit CLI override selects something else.

The Copilot SDK's `contextTier: "long_context"` is a separate **session RPC**
option. Codex uses the Responses HTTP contract, not Copilot SDK sessions.
Conduit does not invent a `context_tier` HTTP field or claim that a local
budget switches the server to an undocumented tier. The 872k option stays
within the advertised Copilot limit; it does not raise account limits.

**Verification boundary:** the test confirmed real search, upstream `max`
effort and the exact runtime client budget. It did **not** submit a full
872,000-token prompt or establish full-window retrieval quality/throughput.
Start a new Codex invocation with the command above; an already running
session does not acquire these overrides automatically.

## What was actually tested

| Path | Live result |
|---|---|
| Codex + `gpt-5.4-mini` | Text, shell, custom grammar `apply_patch`, file verification and multi-turn tool results passed |
| Codex + `gpt-6-astra` / `gpt-5.6-sol` | Shell, custom `apply_patch`, file verification, history replay and strict JSON-schema output passed |
| Responses reasoning history | Opaque reasoning items survived the CLI tool loop |
| `text.format` JSON schema | Strict object `{"ok":true,"value":42}` returned |
| Sol native `web_search` | Real `web_search_call` plus URL citation returned |
| Astra native `web_search` at `max` | Real search/open-page calls and citations; upstream echoed max |
| Astra explicit 872k budget | Real Codex runtime context count was exactly 872,000; not a full-window stress test |
| Codex + Playwright MCP 0.0.82 | Navigation, form fill, click, verified page state and screenshot/image feedback passed |
| Desktop Work + Astra / max + local `@Computer` | Native Cocoa app observation, code entry, Verify click, two screenshots and an independent success marker passed |
| `computer` with `gpt-6-astra` | HTTP 400, `unsupported_value`, tool not supported |
| `computer_use_preview` with Sol | HTTP 400, `unsupported_value`, tool not supported |

These are point-in-time results, not guarantees about every model or account.
No personal browser profile or desktop was used for the browser test.
The catalog enables verified freeform patches on these three models. Its
deferred tool-search and CLI MCP-browser capability flags remain verified only
for the mini baseline. The desktop Astra screenshot/action test is separately
scoped; it does not establish deferred tool search or every CLI browser setup.

### Web search

Native Responses `web_search` definitions, options, search-call output items
and URL citations are passed through, not translated into a fake function.
Use a model that actually supports search and explicitly enable it in Codex:

```toml
web_search = "live"
```

Through the helper (this path was also tested with actual Codex search events):

```bash
./bin/conduit-codex --model gpt-5.6-sol -- \
  -c 'web_search="live"' exec "Search for the official OpenAI Codex repository"
```

The default is disabled because availability is model-dependent. Cached/live
search options are upstream capabilities; Conduit does not manufacture a
search cache or implement the experimental `/alpha/search` service.

Claude Code's dedicated Anthropic search requests retain their existing
Sol-backed conversion. Allowed domains, approximate location and search-use
limits are forwarded where representable. Unsupported constraints and failed
searches are explicit errors; a failed backend is not reported as "no results."
A configured Tavily fallback remains a separate service.

## Computer use: the important distinction

**Native OpenAI computer tools are not available through the tested Copilot
API.** Both modern `computer` and legacy `computer_use_preview` were rejected.
Also, Codex CLI 0.155.1 does not provide a native `computer_call` executor just
because a proxy forwards that item.

**CLI browser automation through MCP does work.** This is a client-executed
tool workflow: Codex calls a local MCP server, the server operates an isolated
browser, and text/images return through Responses function-tool outputs.
It is not native hosted computer use, and it does not grant control of your
macOS desktop.

**The official desktop's local `@Computer` plugin also works through Conduit
in the tested Work configuration.** Its `cua_repl` tools execute locally in
the official native helper; screenshots and tool results return to Astra
through Responses. This is a third, distinct path, requiring macOS permissions
and approval for the target app. See the
[native desktop verification](#computer-setup-and-current-verification-boundary)
above. It does not make Copilot accept hosted `computer` tool definitions or
add a desktop executor to Codex CLI.

An example interactive browser MCP configuration:

```toml
[mcp_servers.playwright]
command = "bunx"
args = ["@playwright/mcp@0.0.82", "--headless", "--isolated", "--browser=chrome"]
required = true
startup_timeout_sec = 30
tool_timeout_sec = 60
default_tools_approval_mode = "prompt"
```

Install Chrome and review the MCP server before enabling it. Use an isolated
profile, restrict destinations appropriate to your task, and retain approvals
for real accounts or consequential actions. Origin allowlists alone are not
a complete browser security boundary. Do not connect to an existing personal
browser profile merely to run the smoke test.

In noninteractive `codex exec`, a tool requiring approval can be refused under
the `never` approval policy; a zero CLI exit code alone does not mean the tool
ran. The opt-in browser smoke runner grants only an explicit tool allowlist
for its temporary localhost fixture and independently verifies the submitted
form and returned screenshot. It does not change your personal MCP settings.

## Reproduce the checks

```bash
# Proxy must already be running with the same key.
bun run test:codex --model gpt-5.4-mini

# Only visible reasoning summaries, plus the existing exact-budget assertion:
bun run test:codex --model gpt-6-astra --reasoning-only \
  --reasoning-effort max --context-budget 872000

# Explicit max effort, exact runtime context budget and native web search:
bun run test:codex --model gpt-6-astra \
  --reasoning-effort max --context-budget 872000 --web-search

# Optional, actual browser automation:
bunx @playwright/mcp@0.0.82 --help
bun run test:codex --model gpt-5.4-mini --browser

# Alternative executable, proxy or Chrome location:
CODEX_BIN=/absolute/path/to/codex \
  bun run test:codex --base-url http://127.0.0.1:7133 --model gpt-5.4-mini
```

The script is opt-in and consumes Copilot usage. It uses a temporary
`CODEX_HOME` and workspace, cleans them up, and fails if actual tool/file/image
evidence is missing. `CONDUIT_CHROME_PATH` optionally selects a Chrome binary.
Ordinary `bun run test` uses mocked upstreams and makes no inference requests.
The smoke runner otherwise prefers low reasoning for cost control; use the
explicit option when verifying `max`. A requested context budget is checked
against actual saved Codex token-count events in the temporary home.

## Reliability and unsupported surfaces

- **Streaming:** fragmented UTF-8 and CR/LF/CRLF framing are handled. Completed
  output items are preserved/recovered before terminal completion. EOF or
  `[DONE]` alone is not a successful Responses completion.
- **Errors:** upstream status/code/parameter and retry hints are preserved.
  Failed/incomplete streams are recorded as failures rather than successful
  requests. Disconnecting the client cancels the upstream request.
- **Context:** images, large text/tool results and encrypted reasoning are not
  automatically discarded. Compact in Codex or reduce attachments if Copilot
  rejects an oversized request.
- **Compaction:** OpenAI's `/responses/compact` is not emulated. That endpoint
  returns an explicit 501; use a custom Conduit provider so Codex selects its
  local summarization workflow.
- **WebSockets:** use HTTP/SSE. A WebSocket upgrade receives 426 for Codex's
  fallback path; no connection-local continuation state is fabricated.
- **Other hosted products:** forwarding JSON is not an implementation of
  OpenAI file storage, remote MCP hosting, image generation, audio, hosted
  containers or desktop control. Any such feature must be supported by the
  actual upstream and tested separately.
- **Privacy:** normal logging records request metadata/usage/errors, not
  automatic conversation or screenshot dumps. Generated catalogs and keys
  are local files and should not be committed.

## Codex CLI versus the graphical Chat / Work interface

Checked against OpenAI's current documentation on 2026-09-21:

| Entry point | Main emphasis |
|---|---|
| ChatGPT **Chat** | Questions, conversation, web research, ideas and short drafts |
| ChatGPT **Work** | Multi-step tasks that produce reviewable results, such as reports, presentations, spreadsheets and workflows |
| Graphical **Codex** view | Developer-facing project, Git/diff, test and review workflows, with more technical detail |
| **Codex CLI** | The terminal client used by `conduit-codex` and `cx` |

OpenAI documents overlapping core capabilities between Work and Codex, with
different product views and execution environments. Work on the web runs in a managed cloud
environment; the desktop app can offer local or cloud work depending on account,
workspace and available features. Chat / Work is an interaction/workflow choice,
not a reasoning-effort setting or a sandbox-permission switch.

This project's route is:

```text
cx -> official Codex CLI -> local Conduit proxy -> GitHub Copilot inference
```

The CLI remains OpenAI's Codex client. Conduit changes its model-provider
connection; it does not turn it into Copilot CLI or the ChatGPT desktop app.
Official ChatGPT Work and Codex share OpenAI usage limits, whereas inference
through this proxy consumes the selected GitHub Copilot account's usage.
Those entitlements are not automatically interchangeable.

The `cx` shortcut's overrides apply to its CLI process. The separate `cxg`
launcher now configures and verifies the official desktop app's **local
Work/Codex** route through Conduit. This does not supply all hosted ChatGPT,
browser, desktop, plugin or cloud features merely by proxying Responses; see
[the tested desktop scope above](#official-desktop-gui-through-conduit-macos).

Sources: [OpenAI mode comparison](https://learn.chatgpt.com/docs/use-chatgpt),
[Work and local/cloud execution](https://learn.chatgpt.com/docs/get-started-with-work),
[official usage/plan rules](https://learn.chatgpt.com/docs/pricing).

## Upstream references

- [Codex 0.155.1 release](https://github.com/openai/codex/releases/tag/rust-v0.155.1)
- [Pinned provider contract](https://github.com/openai/codex/blob/be2951ea34f0d295ed0becf97079f92fa5f6950e/codex-rs/model-provider-info/src/lib.rs)
- [Pinned Responses SSE decoder](https://github.com/openai/codex/blob/be2951ea34f0d295ed0becf97079f92fa5f6950e/codex-rs/codex-api/src/sse/responses.rs)
- [Pinned model metadata schema](https://github.com/openai/codex/blob/be2951ea34f0d295ed0becf97079f92fa5f6950e/codex-rs/protocol/src/openai_models.rs)
- [Codex usable-window and compaction calculation](https://github.com/openai/codex/blob/be2951ea34f0d295ed0becf97079f92fa5f6950e/codex-rs/protocol/src/openai_models.rs#L503-L523)
- [Copilot SDK context-tier session option](https://github.com/github/copilot-sdk/blob/ca166d3eeec17b8efe0294af4b1ef9ca0f4445de/nodejs/src/types.ts#L2376-L2383)
- [Codex MCP documentation](https://developers.openai.com/codex/mcp/)
- [Codex browser availability](https://developers.openai.com/codex/browser/?surface=cli)
- [OpenAI computer-use API](https://developers.openai.com/api/docs/guides/tools-computer-use)
