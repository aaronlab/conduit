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
- Eighteen focused listener/mobile/GUI tests and strict TypeScript checking
  passed. No physical iPhone or Android hardware test was substituted with
  these checks.

The physical phone installation and QR scan must be performed on the user's
device. Browser-width and relay checks are not represented as a completed
iPhone hardware test.

Sources: [Paseo configuration](https://paseo.sh/docs/configuration),
[security model](https://paseo.sh/docs/security),
[open-source relay](https://github.com/getpaseo/paseo-relay).
