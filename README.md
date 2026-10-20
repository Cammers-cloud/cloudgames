# CloudPlay — Queue + Host Coordinator (prototype)

This project adds a real server-side queue and on-demand host allocator to the existing CloudPlay WebRTC prototype. It preserves the current screen-share/manual signaling lab and browser input test.

## What is included

- `index.html` — existing CloudPlay interface plus a queue panel that joins, polls, displays queue position/host count, and leaves a request.
- `functions/api/[[path]].js` — Cloudflare Pages Function that forwards `/api/*` requests to the queue Durable Object.
- `worker.js` + `wrangler.toml` — coordinator API and Durable Object state for queue tickets and host leases.
- `host-agent/host-agent.mjs` — generic host coordinator for manually prepared desktops.
- `host-agent/waydroid-host-agent.mjs` — Linux/Waydroid host coordinator that checks Waydroid, opens its UI, and attempts to launch the configured Android package when a queue ticket is assigned.

## Important boundary

This delivers queueing and host coordination, **not a free Roblox computer**. Cloudflare Pages/Workers/Durable Objects do not provide a Windows desktop/GPU for running Roblox. The Waydroid agent can attempt to launch an installed Android package, but it does not install Roblox, capture a desktop, inject remote input into Android, or automatically establish a WebRTC media session. The current WebRTC screen-sharing lab still requires a host operator to select the Waydroid window/display and exchange offer/answer details manually. Its DataChannel input test does not control the Android environment. Do not treat queue `ready` as proof that the game or remote controls work.

Roblox's published desktop requirements list Windows 10/11 and macOS as supported computer platforms and say Linux is not supported. See Roblox Support: https://en.help.roblox.com/hc/en-us/articles/203312800-Computer-Hardware-Operating-System-Requirements

## Deploy the queue backend

You need a Cloudflare account and your existing Pages project. The following commands run on a machine with Node.js and Wrangler installed. If you are using only a Chromebook, you can edit/upload files in GitHub, but the host agent itself must run on a separate compatible host machine.

1. Put `index.html` at the root of the GitHub repository used by Cloudflare Pages.
2. Put the `functions/` directory beside `index.html` at the repository root. Pages will deploy `functions/api/[[path]].js` as `/api/*`.
3. In a local project folder containing `worker.js` and `wrangler.toml`, install Wrangler if needed (`npm install --save-dev wrangler`).
4. Deploy the coordinator Worker:
   ```sh
   npx wrangler deploy
   ```
5. Set a long random host secret:
   ```sh
   npx wrangler secret put HOST_TOKEN
   ```
   Enter the same secret later as `CLOUDPLAY_HOST_TOKEN` on each host machine. Do not put this secret in `index.html`, GitHub, or a public issue.
6. In Cloudflare Dashboard → Workers & Pages → your Pages project → Settings → Bindings, add a **Durable Object** binding:
   - Variable name: `CLOUDPLAY_QUEUE`
   - Durable Object class: `CloudPlayQueue`
   - Script/Worker: `cloudplay-host-coordinator`
7. Redeploy the Pages project after adding the binding.
8. Open `https://YOUR-PAGES-DOMAIN/api/health`. A JSON response containing `"ok":true` means the queue backend is reachable. If you see `Queue backend is not configured`, the Pages binding is missing or the project has not been redeployed.

If your Worker name changes in `wrangler.toml`, choose that exact deployed Worker in the Pages binding configuration.

## Register a host

The host agent requires Node.js 20+ and a host computer that you are allowed to use. It is only a coordinator client; it does not turn a Chromebook or Cloudflare Worker into a gaming PC.

On the host computer, set environment variables:

**Windows PowerShell**
```powershell
$env:CLOUDPLAY_API = "https://YOUR-PAGES-DOMAIN"
$env:CLOUDPLAY_HOST_TOKEN = "YOUR_HOST_TOKEN"
$env:CLOUDPLAY_HOST_ID = "host-one"
$env:CLOUDPLAY_HOST_LABEL = "Windows host"
node .\host-agent\host-agent.mjs
```

The host should appear online when a queue ticket is refreshed. The agent claims one queued ticket at a time. When a ticket is assigned, the operator must actually prepare the desktop before typing `ready` into the host-agent terminal. Type `fail` if the host cannot prepare the session, or `finish` when the session ends.


## Waydroid host (experimental)

This is an optional experimental host mode for a Linux computer you own or are authorized to use. It cannot run on the Cloudflare Pages site or on ordinary browser JavaScript alone. Waydroid requires a compatible Linux desktop environment; the official setup guide documents supported distributions and Wayland requirements: https://docs.waydro.id/usage/install-on-desktops.

**Roblox compatibility is not guaranteed.** Roblox's current Android security guidance says virtual devices/emulators may fail integrity checks, and recommends avoiding them for experiences requiring remote attestation: https://en.help.roblox.com/hc/en-us/articles/49648939984916-Android-Remote-Attestation. Do not try to bypass those checks. Some experiences may simply refuse to launch or join.

### Prepare the Linux host

1. Install Waydroid using the official instructions for your Linux distribution.
2. Start the container from a terminal with the required administrator permission:
   ```sh
   sudo waydroid container start
   ```
3. In the logged-in desktop user session, initialize/start Waydroid as required by its official guide and verify `waydroid status` reports a running session.
4. Install Roblox only from an official supported app store if it is offered for that environment. Do not use modified APKs or attempt to bypass integrity checks.
5. From the CloudPlay project folder, run the agent with Node.js 20 or newer:
   ```sh
   export CLOUDPLAY_API="https://YOUR-PAGES-DOMAIN"
   export CLOUDPLAY_HOST_TOKEN="YOUR_HOST_TOKEN"
   export CLOUDPLAY_HOST_ID="waydroid-host-one"
   export CLOUDPLAY_HOST_LABEL="Waydroid Linux host"
   node host-agent/waydroid-host-agent.mjs
   ```
   Optional: set `CLOUDPLAY_ANDROID_PACKAGE` to a different Android package ID. The default is `com.roblox.client`.
6. When a ticket is assigned, the agent checks status, attempts to start the user session, opens the Waydroid UI, and runs `waydroid app launch com.roblox.client`. If Waydroid is not ready or the app is unavailable, it reports an error; it does not mark the ticket ready automatically.
7. For the current manual streaming prototype, open CloudPlay on the host, choose **Share screen**, select the Waydroid window/display, then complete the WebRTC offer/answer exchange with the remote browser. Confirm video and app operation before typing `ready` in the agent terminal.

### What is still not complete

- No automatic WebRTC signaling between the queue ticket and host; the existing offer/answer flow is manual.
- No host-side input adapter sends remote keyboard/touch events into Waydroid. The current input channel only demonstrates event receipt in the browser test target.
- No automatic host provisioning or guaranteed free compute. A compatible Linux host must already be running and online.
- No guarantee Roblox accepts a virtual Android device or that a particular experience permits joining.

The project is therefore an experimental queue + Waydroid launcher + manual screen-share workflow, **not yet a complete playable cloud gaming service**.

## Queue API

All user-facing endpoints are same-origin under `/api`:

- `GET /api/health`
- `POST /api/queue/join` — JSON `{ "clientId": "stable-browser-id" }`
- `GET /api/queue/status?id=TICKET_ID`
- `POST /api/queue/leave` — JSON `{ "id": "TICKET_ID" }`

Host endpoints require `Authorization: Bearer HOST_TOKEN`:

- `POST /api/host/register` — `{ "hostId": "host-one", "label": "Windows host" }`
- `POST /api/host/heartbeat` — `{ "hostId": "host-one" }`
- `POST /api/host/claim` — `{ "hostId": "host-one" }`
- `POST /api/host/ready` — `{ "hostId": "host-one", "ticketId": "..." }`
- `POST /api/host/fail` — `{ "hostId": "host-one", "ticketId": "...", "reason": "..." }`
- `POST /api/host/finish` — `{ "hostId": "host-one", "ticketId": "..." }`

## Validation checklist

- `GET /api/health` responds with JSON and `ok: true`.
- Queue UI reports backend reachable rather than backend unavailable.
- Clicking **Find a host** creates a ticket and shows a queue position.
- A registered host agent claims the oldest ticket.
- Typing `ready` changes the browser ticket to `ready` within a few seconds.
- Leaving the queue cancels a queued/assigned ticket.
- The existing WebRTC lab still works separately; queue readiness alone does not mean video/input streaming is connected.

## Security and production gaps

This is a prototype. Before public multi-user deployment, add user authentication, rate limits, anti-abuse controls, host vetting, lease expiry/recovery, audit logging, and a secure signaling/credential exchange. Never expose the host token to browsers. Only connect to hosts you trust and have permission to control.
