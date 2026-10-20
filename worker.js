const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type,authorization",
  "cache-control": "no-store"
};

const json = (data, status = 200, extraHeaders = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      "content-type": "application/json; charset=utf-8",
      ...extraHeaders
    }
  });

const now = () => Date.now();
const HOST_ONLINE_MS = 45_000;
const TICKET_TTL_MS = 6 * 60 * 60 * 1000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders
      });
    }

    if (path === "/" && request.method === "GET") {
      return json({
        service: "CloudPlay host coordinator",
        ok: true,
        note: "Queue routes are available under /api/queue/* and /api/host/*.",
        routes: [
          "GET /health",
          "POST /api/queue/join",
          "GET /api/queue/status?id=TICKET_ID",
          "POST /api/queue/leave",
          "POST /api/host/register",
          "POST /api/host/heartbeat",
          "POST /api/host/claim",
          "POST /api/host/ready",
          "POST /api/host/fail",
          "POST /api/host/finish"
        ]
      });
    }

    // Translate public API paths into Durable Object paths.
    let targetPath = path;

    if (path.startsWith("/api/")) {
      targetPath = path.slice(4);
    }

    const isQueueRoute = [
      "/health",
      "/queue/join",
      "/queue/status",
      "/queue/leave"
    ].includes(targetPath);

    const isHostRoute = targetPath.startsWith("/host/");

    if (!isQueueRoute && !isHostRoute) {
      return json({
        ok: false,
        error: "Not found",
        path
      }, 404);
    }

    // This binding must be configured in Cloudflare settings.
    if (!env.CLOUDPLAY_QUEUE) {
      return json({
        ok: false,
        error: "CLOUDPLAY_QUEUE Durable Object binding is missing.",
        requiredBinding: "CLOUDPLAY_QUEUE",
        targetPath
      }, 503);
    }

    try {
      const id = env.CLOUDPLAY_QUEUE.idFromName(
        "cloudplay-global-queue-v1"
      );

      const stub = env.CLOUDPLAY_QUEUE.get(id);

      const targetUrl = new URL(
        targetPath + url.search,
        "https://cloudplay-queue.internal"
      );

      const init = {
        method: request.method,
        headers: request.headers
      };

      if (
        request.method !== "GET" &&
        request.method !== "HEAD"
      ) {
        init.body = await request.arrayBuffer();
      }

      const upstream = await stub.fetch(
        new Request(targetUrl.toString(), init)
      );

      const headers = new Headers(upstream.headers);

      for (const [key, value] of Object.entries(corsHeaders)) {
        headers.set(key, value);
      }

      headers.set(
        "x-cloudplay-route",
        "worker-to-durable-object"
      );

      headers.set("x-cloudplay-target", targetPath);

      return new Response(upstream.body, {
        status: upstream.status,
        headers
      });
    } catch (error) {
      return json({
        ok: false,
        error: "Could not forward request to CloudPlayQueue.",
        details: String(error?.message || error),
        targetPath
      }, 502);
    }
  }
};

export class CloudPlayQueue {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders
      });
    }

    try {
      if (path === "/health" && request.method === "GET") {
        const state = await this.state();

        return this.reply({
          ok: true,
          service: "CloudPlay queue",
          queued: state.tickets.filter(
            ticket => ticket.status === "queued"
          ).length,
          onlineHosts: this.onlineHosts(state).length
        });
      }

      if (
        path === "/queue/join" &&
        request.method === "POST"
      ) {
        return await this.join(await request.json());
      }

      if (
        path === "/queue/status" &&
        request.method === "GET"
      ) {
        return await this.status(
          url.searchParams.get("id")
        );
      }

      if (
        path === "/queue/leave" &&
        request.method === "POST"
      ) {
        return await this.leave(await request.json());
      }

      if (path.startsWith("/host/")) {
        if (!this.authorized(request)) {
          return this.reply({
            error: "Host authentication failed."
          }, 401);
        }

        if (
          path === "/host/register" &&
          request.method === "POST"
        ) {
          return await this.registerHost(
            await request.json()
          );
        }

        if (
          path === "/host/heartbeat" &&
          request.method === "POST"
        ) {
          return await this.heartbeat(
            await request.json()
          );
        }

        if (
          path === "/host/claim" &&
          request.method === "POST"
        ) {
          return await this.claim(
            await request.json()
          );
        }

        if (
          path === "/host/ready" &&
          request.method === "POST"
        ) {
          return await this.markReady(
            await request.json()
          );
        }

        if (
          path === "/host/fail" &&
          request.method === "POST"
        ) {
          return await this.fail(
            await request.json()
          );
        }

        if (
          path === "/host/finish" &&
          request.method === "POST"
        ) {
          return await this.finish(
            await request.json()
          );
        }
      }

      return this.reply({
        error: "Not found"
      }, 404);
    } catch (error) {
      return this.reply({
        error: error?.message || "Request failed"
      }, 400);
    }
  }

  async state() {
    let state = await this.ctx.storage.get("state");

    if (!state) {
      state = {
        tickets: [],
        hosts: []
      };
    }

    const cutoff = now() - TICKET_TTL_MS;

    state.tickets = state.tickets.filter(
      ticket => ticket.createdAt > cutoff
    );

    state.hosts = state.hosts.filter(
      host => now() - host.lastSeen < 24 * 60 * 60 * 1000
    );

    return state;
  }

  async save(state) {
    await this.ctx.storage.put("state", state);
  }

  reply(data, status = 200) {
    return json(data, status);
  }

  authorized(request) {
    const expected = this.env.HOST_TOKEN;

    return Boolean(
      expected &&
      request.headers.get("authorization") ===
        `Bearer ${expected}`
    );
  }

  onlineHosts(state) {
    return state.hosts.filter(
      host => now() - host.lastSeen < HOST_ONLINE_MS
    );
  }

  publicTicket(ticket, state) {
    const queued = state.tickets
      .filter(item => item.status === "queued")
      .sort((a, b) => a.createdAt - b.createdAt);

    const position =
      ticket.status === "queued"
        ? queued.findIndex(item => item.id === ticket.id) + 1
        : 0;

    const host = ticket.hostId
      ? state.hosts.find(item => item.id === ticket.hostId)
      : null;

    const online = this.onlineHosts(state).length;

    return {
      id: ticket.id,
      status: ticket.status,
      position,
      queued: queued.length,
      onlineHosts: online,
      createdAt: ticket.createdAt,
      updatedAt: ticket.updatedAt,
      hostLabel: host?.label || null,
      message: this.message(ticket.status, position, online)
    };
  }

  message(status, position, online) {
    if (status === "queued") {
      return online
        ? `Waiting in queue at position ${position}. A host will claim your session when available.`
        : `Waiting at position ${position}. No compatible host is online yet.`;
    }

    if (status === "assigned") {
      return "A host has claimed your request and is preparing the desktop.";
    }

    if (status === "ready") {
      return "The host reports that its desktop is ready. Complete the WebRTC screen-share handshake to begin streaming.";
    }

    if (status === "failed") {
      return "The previous host could not start this session. Join the queue again to retry.";
    }

    if (status === "cancelled") {
      return "Queue request cancelled.";
    }

    if (status === "finished") {
      return "Session ended.";
    }

    return "Checking session status.";
  }

  async join(body) {
    const state = await this.state();
    const clientId = String(body.clientId || "").slice(0, 100);

    if (!clientId) {
      return this.reply({
        error: "clientId is required"
      }, 400);
    }

    const existing = state.tickets.find(
      ticket =>
        ticket.clientId === clientId &&
        ["queued", "assigned", "ready"].includes(ticket.status)
    );

    if (existing) {
      return this.reply(this.publicTicket(existing, state));
    }

    const ticket = {
      id: crypto.randomUUID(),
      clientId,
      createdAt: now(),
      updatedAt: now(),
      status: "queued",
      hostId: null
    };

    state.tickets.push(ticket);

    await this.save(state);

    return this.reply(
      this.publicTicket(ticket, state),
      201
    );
  }

  async status(id) {
    if (!id) {
      return this.reply({
        error: "id is required"
      }, 400);
    }

    const state = await this.state();

    const ticket = state.tickets.find(
      item => item.id === id
    );

    if (!ticket) {
      return this.reply({
        error: "Queue ticket not found or expired",
        status: "missing",
        onlineHosts: this.onlineHosts(state).length
      }, 404);
    }

    return this.reply(this.publicTicket(ticket, state));
  }

  async leave(body) {
    const state = await this.state();

    const ticket = state.tickets.find(
      item => item.id === body.id
    );

    if (!ticket) {
      return this.reply({
        ok: true,
        status: "missing"
      });
    }

    if (["queued", "assigned"].includes(ticket.status)) {
      ticket.status = "cancelled";
      ticket.updatedAt = now();

      const host = state.hosts.find(
        item => item.id === ticket.hostId
      );

      if (
        host &&
        host.currentTicketId === ticket.id
      ) {
        host.currentTicketId = null;
        host.status = "online";
      }
    }

    await this.save(state);

    return this.reply({
      ok: true,
      ...this.publicTicket(ticket, state)
    });
  }

  async registerHost(body) {
    const id = String(body.hostId || "").slice(0, 100);

    if (!id) {
      return this.reply({
        error: "hostId is required"
      }, 400);
    }

    const state = await this.state();

    let host = state.hosts.find(
      item => item.id === id
    );

    if (!host) {
      host = {
        id,
        label: String(
          body.label || "CloudPlay host"
        ).slice(0, 80),
        status: "online",
        lastSeen: now(),
        currentTicketId: null
      };

      state.hosts.push(host);
    }

    host.label = String(
      body.label || host.label
    ).slice(0, 80);

    host.lastSeen = now();

    if (!host.currentTicketId) {
      host.status = "online";
    }

    await this.save(state);

    return this.reply({
      ok: true,
      hostId: host.id,
      status: host.status,
      onlineHosts: this.onlineHosts(state).length
    });
  }

  async heartbeat(body) {
    const state = await this.state();

    const host = state.hosts.find(
      item => item.id === body.hostId
    );

    if (!host) {
      return this.reply({
        error: "Host is not registered. Call /host/register first."
      }, 404);
    }

    host.lastSeen = now();

    await this.save(state);

    return this.reply({
      ok: true,
      status: host.status,
      currentTicketId: host.currentTicketId
    });
  }

  async claim(body) {
    const state = await this.state();

    const host = state.hosts.find(
      item => item.id === body.hostId
    );

    if (!host) {
      return this.reply({
        error: "Host is not registered"
      }, 404);
    }

    host.lastSeen = now();

    if (host.currentTicketId) {
      const active = state.tickets.find(
        ticket =>
          ticket.id === host.currentTicketId &&
          ["assigned", "ready"].includes(ticket.status)
      );

      if (active) {
        await this.save(state);

        return this.reply({
          ticket: this.publicTicket(active, state),
          alreadyAssigned: true
        });
      }

      host.currentTicketId = null;
    }

    const ticket = state.tickets
      .filter(item => item.status === "queued")
      .sort((a, b) => a.createdAt - b.createdAt)[0];

    if (!ticket) {
      host.status = "online";

      await this.save(state);

      return this.reply({
        ticket: null,
        status: "idle"
      });
    }

    ticket.status = "assigned";
    ticket.hostId = host.id;
    ticket.updatedAt = now();

    host.status = "busy";
    host.currentTicketId = ticket.id;

    await this.save(state);

    return this.reply({
      ticket: this.publicTicket(ticket, state),
      alreadyAssigned: false
    });
  }

  async markReady(body) {
    const state = await this.state();

    const host = state.hosts.find(
      item => item.id === body.hostId
    );

    const ticket = state.tickets.find(
      item => item.id === body.ticketId
    );

    if (
      !host ||
      !ticket ||
      ticket.hostId !== host.id ||
      ticket.status !== "assigned"
    ) {
      return this.reply({
        error: "No matching assigned ticket"
      }, 409);
    }

    host.lastSeen = now();
    ticket.status = "ready";
    ticket.updatedAt = now();

    await this.save(state);

    return this.reply({
      ok: true,
      ticket: this.publicTicket(ticket, state)
    });
  }

  async fail(body) {
    const state = await this.state();

    const host = state.hosts.find(
      item => item.id === body.hostId
    );

    const ticket = state.tickets.find(
      item => item.id === body.ticketId
    );

    if (
      !host ||
      !ticket ||
      ticket.hostId !== host.id
    ) {
      return this.reply({
        error: "No matching host/ticket"
      }, 409);
    }

    ticket.status = "failed";
    ticket.updatedAt = now();

    ticket.failureReason = String(
      body.reason || "Host failed to prepare session"
    ).slice(0, 300);

    host.currentTicketId = null;
    host.status = "online";
    host.lastSeen = now();

    await this.save(state);

    return this.reply({
      ok: true
    });
  }

  async finish(body) {
    const state = await this.state();

    const host = state.hosts.find(
      item => item.id === body.hostId
    );

    const ticket = state.tickets.find(
      item => item.id === body.ticketId
    );

    if (
      !host ||
      !ticket ||
      ticket.hostId !== host.id
    ) {
      return this.reply({
        error: "No matching host/ticket"
      }, 409);
    }

    ticket.status = "finished";
    ticket.updatedAt = now();

    host.currentTicketId = null;
    host.status = "online";
    host.lastSeen = now();

    await this.save(state);

    return this.reply({
      ok: true
    });
  }
}
