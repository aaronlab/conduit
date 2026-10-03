# Remote access to your local Claude Code

For an open-source iPhone/Android **Codex conversation client**, see the
[Paseo mobile integration](./MOBILE.md). This page describes the separate
legacy browser-terminal route; it is not synchronization with the official
ChatGPT desktop GUI.

`bin/conduit-remote` exposes a persistent tmux session — perfect for running
Claude Code — through a browser-based terminal. Open it on your phone,
iPad, or another laptop and you're driving the same Claude Code session
running on this Mac.

Stack: `tmux` (session persistence) + `ttyd` (TLS-capable web terminal with
basic auth). Both installed with `brew install tmux ttyd`.

---

## Quick start

```bash
# from the conduit repo root
bin/conduit-remote --writable
```

This binds to **127.0.0.1:7134** with HTTP basic auth.
Username: `conduit`. Password: whatever is in `.conduit-key` (i.e.
`$CONDUIT_API_KEY`), or override with `CONDUIT_REMOTE_PASSWORD=…`.

Inside the web terminal, run `claude` (or your `claude-copilot` alias).
Detach with `Ctrl-b d` — the tmux session keeps running so any device can
reattach later.

Useful flags:

| Flag | Effect |
|---|---|
| `--lan` | Bind `0.0.0.0` so devices on the same Wi-Fi can connect to `http://<this-mac>.local:7134` |
| `--cloudflare` | Also start a Cloudflare Tunnel (ephemeral `*.trycloudflare.com` URL) so any device on the internet can reach it over HTTPS |
| `--port N` | Change port (default 7134) |
| `--session NAME` | Change tmux session name (default `conduit-remote`) |
| `--user NAME` | Change basic-auth user (default `conduit`) |
| `--writable` | Allow remote keyboard input. **Without this, ttyd is read-only.** |
| `--status` | Show whether tmux, ttyd, and the tunnel are running |
| `--kill` | Tear it all down (tmux + ttyd + tunnel) |

> ⚠️ `--writable` gives anyone who knows the password full shell access on
> your Mac. The default 32-char hex `CONDUIT_API_KEY` is strong, but only
> enable `--lan` (or any internet exposure) on networks you trust.

---

## Reaching it from another device

`bin/conduit-remote` only opens a port on this Mac. Pick one of the four
paths below depending on where the other device is and how much trust you
have in the network.

### 1. Same Wi-Fi (simplest)

```bash
bin/conduit-remote --lan --writable
```

Open `http://<your-mac-name>.local:7134` (or the printed IP) in any browser
on the same network. Auth with `conduit` / `$CONDUIT_API_KEY`.

### 2. Anywhere via Tailscale (recommended for daily use)

[Tailscale](https://tailscale.com) gives every device a stable private IP
over WireGuard with zero port-forwarding. Free for personal use.

```bash
brew install --cask tailscale
open -a Tailscale         # sign in once
# leave conduit-remote bound to localhost; Tailscale routes to it
bin/conduit-remote --writable
```

On the other device (after installing Tailscale and logging into the same
account): open `http://<mac-tailscale-name>:7134`. Works on cellular, hotel
Wi-Fi, anywhere.

### 3. Anywhere via Cloudflare Tunnel

```bash
brew install cloudflared
bin/conduit-remote --writable --cloudflare
```

The script starts `cloudflared tunnel --url http://127.0.0.1:7134` in the
background, waits for the tunnel to come up, and prints a
`https://<random>.trycloudflare.com` URL — public HTTPS, no Cloudflare
account needed. The URL rotates each time `--cloudflare` is started. The
PID and URL are saved under `data/conduit-cloudflared.{pid,url,log}` and
torn down by `--kill`.

For a stable hostname, switch to a named tunnel against your own Cloudflare
domain: `cloudflared tunnel create` → `cloudflared tunnel route dns …` →
add a `~/.cloudflared/<id>.json` config — that's a separate setup and the
script doesn't manage it.

> The tunnel makes the URL reachable from the public internet — basic
> auth is the only thing standing between strangers and your shell. Use a
> long password and consider Tailscale instead for private use.

### 4. SSH port-forward (no extra software on the Mac)

If you already have macOS Remote Login enabled (System Settings → General
→ Sharing → Remote Login), from any device with an SSH client:

```bash
ssh -N -L 7134:127.0.0.1:7134 <you>@<your-mac>
# then open http://127.0.0.1:7134 in the device's browser
```

For phones/iPads, Termius and Blink can both set up the port-forward and
embed a browser.

---

## How it stays alive across disconnects

The script creates a named tmux session (default `conduit-remote`). ttyd
just runs `tmux attach-session -t conduit-remote` for each connection.
Closing your browser tab, putting your phone to sleep, or losing
connectivity all leave the tmux session running — reconnect and you pick up
where Claude Code left off.

To attach locally (no browser):

```bash
tmux attach -t conduit-remote
```

To force-kill everything (web server + tmux session):

```bash
bin/conduit-remote --kill
```

---

## File layout

| Path | Purpose |
|---|---|
| `bin/conduit-remote` | The wrapper script |
| `data/conduit-remote.pid` | ttyd PID (used for `--status` / `--kill`) |
| `data/conduit-remote.log` | ttyd stdout/stderr |
| `data/conduit-cloudflared.pid` | cloudflared PID (when `--cloudflare` is active) |
| `data/conduit-cloudflared.url` | Last `*.trycloudflare.com` URL the script captured |
| `data/conduit-cloudflared.log` | cloudflared stdout/stderr |
| `.conduit-key` | Password source (falls back when `CONDUIT_REMOTE_PASSWORD` is unset) |

---

## Troubleshooting

- **`ttyd already running on …`** — another instance is up. `bin/conduit-remote --status` or `--kill`.
- **401 in the browser** — wrong password. Username is `conduit`, password is the value of `CONDUIT_API_KEY` in `.conduit-key` (or `$CONDUIT_REMOTE_PASSWORD`).
- **Black screen, no input** — you forgot `--writable`. ttyd is read-only by default.
- **Can't reach it from another device on the LAN** — restart with `--lan`. macOS firewall may also block port 7134; allow `ttyd` in System Settings → Network → Firewall.
- **Mac sleeps mid-session** — set caffeinate or pmset: `caffeinate -dimsu &` keeps the screen on; `sudo pmset -a sleep 0` disables auto-sleep. For occasional reconnect, plug into power and Mac will keep ttyd reachable while the display sleeps.
