# Phone companion: Paseo + Conduit

Use [Paseo](https://github.com/getpaseo/paseo), an Apache-2.0 open-source
mobile/desktop companion, to converse with Codex running on your Mac through
Conduit. The Mac must be powered on, awake, signed in and online.

```text
iPhone / Android Paseo
  -> Paseo relay (application-layer encrypted transport)
  -> Paseo daemon on your Mac
  -> local Codex app-server
  -> Conduit 127.0.0.1:7133
  -> GitHub Copilot
```

This is **not** hosted ChatGPT Chat, an OpenAI cloud session, or remote desktop
screen sharing. Local execution does not mean offline inference: prompts and
relevant code still go to Copilot.

## Download the phone app

- [iPhone/iPad App Store](https://apps.apple.com/cn/app/paseo-remote-coding-agents/id6758887924)
  (also [US listing](https://apps.apple.com/us/app/paseo-remote-coding-agents/id6758887924)).
- [Android Google Play](https://play.google.com/store/apps/details?id=sh.paseo).
- [Pinned Android APK](https://github.com/getpaseo/paseo/releases/download/v0.10.3/paseo-v0.10.3-android.apk).

The tested release is **Paseo 0.10.3**. The iOS listing was available in both
China and the US on 2026-10-03, with iOS 15.1 as its minimum requirement.
Store availability can change.

## Mac installation

Install the matching [official release](https://github.com/getpaseo/paseo/releases/tag/v0.10.3)
as `~/Applications/Paseo.app`. The managed integration checks its version and
signing publisher; it does not silently download or execute a moving npm tag.
At verification time npm's CLI package lagged behind the desktop release.

For the tested Apple Silicon ZIP:

- File: `Paseo-0.10.3-arm64.zip`
- SHA-256: `b145e842fc2a220f21897a369ff085f938a510e178fbfca4ee9f4e89342e3010`
- Apple signing publisher: Mohamed Boudra Ziani, team `99ZMJMKU9Y`.
- Signature and notarization were checked before execution.

Keep your existing Conduit proxy running for initial setup. If needed, the
new service entry point reads the checkout's key without placing it in argv
and binds to loopback:

```bash
./bin/conduit-proxy
```

In another terminal:

```bash
./bin/cxm setup
./bin/cxm start
./bin/cxm status
./bin/cxm pair
```

Scan the printed QR in the Paseo phone app's host/device connection flow, or
use its pairing-link option. Pairing uses an outbound relay connection; no
router port forwarding, public Conduit port or public desktop debugging port
is needed. **Treat the QR and pairing URL as credentials.**

`cxm pair` now verifies an actual encrypted relay connection before printing
the QR. This verifies the Mac's route, not the phone's network route.

Optionally link `bin/cxm` into a directory on your PATH. On the configured
machine the short command is `cxm`.

## Which conversations are shared?

### New phone-first conversations

Use Paseo on the phone and `cxm open` on the Mac. Both clients use the same
Paseo-owned engine and can view the same session. Choose **Conduit Codex**,
**Astra via Conduit**, **Max**, and **Default permissions**.

The direct local web interface requires the independently generated password
in `~/.paseo-conduit/connection-password`, not your Copilot token or Conduit key.
On its welcome screen, choose **Direct connection**, enter `127.0.0.1:6799`,
and supply that password. The phone normally uses the encrypted pairing route
instead; do not enter the Mac's loopback address on the phone.

Use `cxm open` for this managed desktop connection. Opening the stock Paseo
app icon can select its ordinary `~/.paseo` profile instead; if using that
client, connect it to the existing managed host rather than starting an
unconfigured second daemon.

### Existing official ChatGPT Work/Codex conversations

**Supported and tested as a serial handoff, not simultaneous attachment to
the official GUI's running engine:**

1. Finish the turn in the official ChatGPT app and quit that app.
2. Start Paseo with `cxm start`.
3. Import the native Codex thread:

   ```bash
   cxm import FULL_NATIVE_THREAD_UUID
   ```

   This retains the native thread ID, explicitly sets **Max**, and selects
   **Default permissions** (`on-request` + `workspace-write`). The helper
   refuses to import while the official ChatGPT app is running.

   Alternatively, use Paseo's **Import session** screen to choose an existing
   Codex conversation by name. For imported Astra threads, explicitly select
   **Max** once in the thinking control and **Default permissions** in the
   mode control. Do not infer the actual setting from a default-looking label:
   the tested import initially retained automatic thinking until Max was
   explicitly selected.

4. Continue the conversation on the phone.
5. To return to the official app, finish the phone turn, run `cxm stop`, then
   `cxg` and reopen the original conversation.

Do not drive the **same native thread** from both engines at once. For
simultaneous desktop/phone viewing, use Paseo's clients on both devices.
Paseo has its own agent ID in addition to Codex's native thread UUID; these are
not interchangeable.

This setup shares the dedicated `~/.codex-conduit-gui` profile, not your
personal `~/.codex`. It does not copy conversation databases or overwrite
login state. Imported non-Astra threads need their own supported settings;
the convenience importer does not silently apply Astra's Max preset to them.

## Persistence and controls

| Command | Effect |
|---|---|
| `cxm setup` | Validate/install dedicated configuration and per-user launchd jobs |
| `cxm start` | Start managed services; leave an already-running external proxy alone |
| `cxm status` | Report the actual daemon/worker/provider state |
| `cxm pair` | Display the private pairing QR/link |
| `cxm repair-relay` | Safely reconnect through the documented official relay origin and generate a new verified QR |
| `cxm private` | Start the optional, single-port Tailscale bridge and open first-time authorization |
| `cxm private-login` | Reopen its official authorization page, without logging in for you |
| `cxm private-stop` | Stop only that private-network bridge |
| `cxm open` | Open the local password-protected Paseo interface |
| `cxm import UUID` | Import a saved Astra thread with explicit Max/default permissions |
| `cxm stop` | Stop the mobile service only; keep Conduit running |

Setup creates these per-user jobs:

- `lab.aaronlab.conduit.proxy`
- `lab.aaronlab.conduit.mobile`

They run at login and restart after exit. `cxm stop` unloads the mobile job for
the current login; its plist remains installed for the next login.
Stopping the service can interrupt an active phone task, so finish the turn
first. No macOS sleep, lock-screen or privacy setting is changed automatically.

Managed state lives in `~/.paseo-conduit`, including a bcrypt password hash,
the separate local connection password, relay identity, sessions, pairing
output and logs. The directory is private (0700); generated config and
credential files are 0600. Existing unrelated directories, conflicting
provider settings or launchd jobs are rejected rather than overwritten.

Environment overrides: `CONDUIT_MOBILE_HOME`, `CONDUIT_GUI_HOME`,
`CONDUIT_GUI_DATA_DIR`, `CONDUIT_PASEO_APP_PATH`. Use separate dedicated
directories. Setup intentionally uses the local Conduit endpoint.

The Codex launcher discovers both the older `Resources/codex` layout and the
newer `Resources/codex-cli/bin/codex` layout of the signed official app.
It does not replace a missing bundled executable with an unrelated PATH
binary.

## Native phone app shows 503 after scanning

This is a connection failure, not evidence of an invalid Copilot model or
API key. A healthy local daemon does not prove that the phone can reach its
relay. Do not disable TLS, remove authentication, or expose the daemon on all
interfaces to work around it.

With mobile tasks idle, run:

```bash
cxm repair-relay
```

This checks the official alternate origin's readiness, saves a private
configuration backup, changes **only** relay settings, reconnects, verifies
an encrypted connection, and prints a new QR. It uses
`paseo-relay-next.fly.dev:443`, the HTTPS upstream explicitly listed in
[Paseo 0.10.3's official relay configuration](https://github.com/getpaseo/paseo/blob/v0.10.3/packages/relay/wrangler.toml).
TLS and application-layer E2EE stay enabled; chat records, model settings,
passwords and daemon identity are not reset.

Scan the **new** QR in Paseo. If the phone retained the failed old host
connection, remove that phone-side connection and add it again; this does not
delete the Mac's native conversations. Later `cxm pair` commands preserve the
selected relay route.

This route was verified from the Mac after a phone-reported 503. It bypasses
the original relay hostname's forwarding path, but does not establish the
cause of a phone-specific DNS, proxy, regional-routing or network failure.
The phone still needs a successful connection before its 503 can be declared
resolved. If the repair command itself fails, it does not print a success QR;
encrypted-probe errors are saved in the private
`~/.paseo-conduit/logs/pairing-probe-error.log`.

## Independent private connection when the shared relay still fails

The original relay name and its Fly origin use the same public infrastructure.
If both still return 503 on the phone, do not treat another Mac-only probe as
proof of a fix. The independent alternative is a Tailscale private connection,
which [Paseo officially supports](https://github.com/getpaseo/paseo/blob/v0.10.3/public-docs/connectivity.md#tailscale).

This integration uses Tailscale's official
[`tsnet-proxy`](https://github.com/tailscale/tailscale/blob/v1.102.5/cmd/tsnet-proxy/tsnet-proxy.go),
not a system VPN service or a custom encryption implementation. It exposes
**only the existing Paseo port 6799** through an embedded userspace network.
It does not add a system TUN interface, accept system DNS/routes, expose a
SOCKS proxy, enable Tailscale SSH, or publish a Funnel. Unknown service ports
are not forwarded to other localhost services.

Install the pinned official proxy if it has not already been built:

```bash
mkdir -p ~/.paseo-conduit/bin
GOBIN="$HOME/.paseo-conduit/bin" go install tailscale.com/cmd/tsnet-proxy@v1.102.5
cxm private
```

Go is a build-time requirement, not needed to run the installed binary. Go's
module checksum verification must remain enabled when using a module mirror.
On the configured machine, the binary has already been built and the
single-port process started.

1. Complete the official Tailscale authorization page opened on the Mac using
   your own account. `cxm private-login` reopens the latest link. Do not send
   login credentials or auth keys to anyone.
2. Install [Tailscale on iPhone](https://apps.apple.com/us/app/tailscale/id1470499037)
   and sign in to the same personal tailnet. On 2026-10-03, the US listing was
   available but the China-store lookup returned no app. Do not assume this
   prerequisite is satisfied for a China-only App Store account.
3. In the phone's Tailscale device list, find **conduit-mobile** and copy its
   actual `100.x.x.x` private address. There is no usable private address until
   account authorization succeeds.
4. In Paseo choose **Direct connection**, not the public-relay QR flow. Enter
   that private IP, port **6799**, and leave **Use SSL** off: the raw TCP
   connection is carried inside encrypted WireGuard transport. Do not use this
   setting for an ordinary unencrypted public/LAN connection.
5. Supply the existing, separate Paseo password from
   `~/.paseo-conduit/connection-password`. The Conduit API key is not needed.

The bridge has its own per-user job, `lab.aaronlab.conduit.private`, and
private state under `~/.paseo-conduit/tailnet`. Log uploads are disabled and
ambient `TS_AUTHKEY` automation credentials are not inherited. A temporary
general userspace `tailscaled` probe was stopped; it is not the deployed
single-port bridge.

Tailscale may establish a peer-to-peer path or use its own encrypted DERP
transport. This bypasses Paseo's public relay, not every possible relay in
the network. Phone VPN apps can conflict; their activation and account
authorization remain explicit user actions.

**Verification boundary:** the official binary build, isolated process,
single-port arguments and authorization-link generation were checked.
Account authorization and a successful phone connection are still required;
a running process or printed login URL is not a completed phone test.

## Trust boundaries

- Both managed HTTP listeners stay on `127.0.0.1`; Paseo's API/WebSocket
  require its separate password for direct access. The health endpoint and
  static login-page assets are intentionally public on loopback.
- Relay transport follows Paseo's application-layer E2EE design. The relay
  can still observe IP addresses, timing, traffic sizes and connection IDs.
  This integration is not an independent cryptographic audit.
- A paired client can control a powerful local agent manager, including its
  file/terminal capabilities. Agent-level approval settings do not sandbox
  the entire Paseo daemon. Pair only devices you control.
- No Copilot token or Conduit API key is copied into Paseo's phone pairing
  information. Codex continues to use the existing local credential helper.
- Other providers, automatic agent-tool injection, terminal hooks, dictation
  and voice mode are disabled in the initial managed configuration. Voice
  would need a separate provider/capability check.
- Official desktop `@Computer`, cloud connectors, hosted Study Mode, mobile
  push delivery and lock-screen execution are not established by the chat
  handoff test.

## Verified on 2026-10-03

- A new isolated Paseo conversation used real Copilot inference via Conduit:
  Astra, explicit Max, 872000 usable context, and default permissions.
- A real encrypted relay connection reached the canary daemon without a
  public inbound listener.
- An official desktop-created thread was imported, continued from Paseo's
  actual mobile-width UI, then reopened in the official GUI with its new
  messages and a correct remembered-code response. The **native UUID stayed
  unchanged**; this was not a transcript pasted into a new conversation.
- The official app updated from 26.915.31945 to **26.930.31428** during testing.
  The return handoff used its **Codex 0.160.0** backend; runtime discovery
  handled the relocated executable.
- Initial imported automatic thinking was not counted as Max. After explicit
  selection, the native turn metadata confirmed Max. The importer now makes
  that selection through Paseo's supported API.
- The permanent encrypted pairing sent a real continuation with Max and the
  exact 872000 budget. The same pairing and imported agent remained usable
  after stopping and restarting the managed service.
- Missing/wrong direct HTTP credentials were rejected with 401. A real
  uncredentialed Paseo client was rejected with `AUTH_REQUIRED` at the
  WebSocket application handshake; an HTTP upgrade alone does not establish
  authenticated control.
- Twenty-four focused listener/mobile/GUI tests and strict TypeScript checking
  passed. No physical iPhone or Android hardware test was substituted with
  these checks.

The physical phone installation and QR scan must be performed on the user's
device. Browser-width and relay checks are not represented as a completed
iPhone hardware test.

Sources: [Paseo configuration](https://paseo.sh/docs/configuration),
[security model](https://paseo.sh/docs/security),
[open-source relay](https://github.com/getpaseo/paseo-relay).
