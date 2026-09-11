// catalyst ri48h overlay — cloudflare worker + durable object
// one DO instance ("main") owns the state; every overlay/control tab holds a hibernating socket.

import { DurableObject } from "cloudflare:workers";

type Chip = {
  id: string;
  label: string;
  at: number | null; // epoch ms target; null = static label
  tone: "break" | "recap" | "info";
  repeat: number; // minutes; 0 = one-shot. clients derive the rolled target, no server tick
  visible: boolean;
};

type State = {
  v: number;
  build: { label: string; endsAt: number | null; remainingMs: number; paused: boolean };
  chips: Chip[];
  sponsor: { caption: string; visible: boolean };
  ticker: { text: string; visible: boolean };
  show: { timer: boolean; logo: boolean };
};

const DEFAULT: State = {
  v: 1,
  build: { label: "build time left", endsAt: null, remainingMs: 48 * 3600_000, paused: true },
  chips: [
    { id: "break", label: "next break", at: null, tone: "break", repeat: 0, visible: false },
    { id: "recap", label: "next live recap", at: null, tone: "recap", repeat: 30, visible: false },
  ],
  sponsor: { caption: "sheet metal by", visible: true },
  ticker: { text: "", visible: false },
  show: { timer: true, logo: true },
};

export interface Env {
  OVERLAY: DurableObjectNamespace<OverlayState>;
  ASSETS: Fetcher;
  CONTROL_KEY?: string;
}

export class OverlayState extends DurableObject<Env> {
  state: State = DEFAULT;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.state = { ...DEFAULT, ...((await ctx.storage.get<State>("state")) ?? {}) };
    });
  }

  async fetch(req: Request) {
    const url = new URL(req.url);
    const op = url.searchParams.get("op") === "1";

    if (url.pathname === "/ws") {
      const [client, server] = Object.values(new WebSocketPair());
      // hibernation: no compute billed while the 48h stream sits idle between edits
      this.ctx.acceptWebSocket(server, [op ? "op" : "view"]);
      server.send(this.envelope());
      return new Response(null, { status: 101, webSocket: client });
    }

    if (req.method === "POST") await this.apply(await req.json());
    return new Response(this.envelope(), {
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    if (!this.ctx.getTags(ws).includes("op")) return; // viewers are read-only
    try {
      await this.apply(JSON.parse(String(raw)));
    } catch {
      /* ignore malformed frames rather than dropping the socket */
    }
  }

  webSocketError() {}
  webSocketClose() {}

  private async apply(patch: unknown) {
    this.state = deepMerge(this.state, patch);
    await this.ctx.storage.put("state", this.state);
    const msg = this.envelope();
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(msg);
      } catch {}
    }
  }

  // t lets clients correct for clock skew — a phone running the panel over LTE
  // must not shift everyone's countdown
  private envelope() {
    return JSON.stringify({ ...this.state, t: Date.now() });
  }
}

// arrays replace wholesale, objects merge key-by-key
function deepMerge<T>(base: T, patch: any): T {
  if (Array.isArray(patch) || patch === null || typeof patch !== "object") return patch;
  const out: any = { ...base };
  for (const k of Object.keys(patch)) out[k] = deepMerge((base as any)?.[k], patch[k]);
  return out;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/ws" || url.pathname === "/state") {
      const key = url.searchParams.get("key") ?? req.headers.get("x-control-key") ?? "";
      // no secret set (local dev) = everyone is an operator. set one before you go live.
      const op = !env.CONTROL_KEY || key === env.CONTROL_KEY;
      if (req.method === "POST" && !op) return new Response("bad control key", { status: 401 });

      const target = new URL(req.url);
      target.searchParams.set("op", op ? "1" : "0");
      target.searchParams.delete("key");

      const stub = env.OVERLAY.get(env.OVERLAY.idFromName("main"));
      return stub.fetch(new Request(target, req));
    }

    return env.ASSETS.fetch(req);
  },
};
