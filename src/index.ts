// catalyst ri48h overlay — cloudflare worker + durable object
// one DO instance ("main") owns the state; every overlay/control tab holds a hibernating socket.

import { DurableObject } from "cloudflare:workers";

// a cue is one thing that happens at a moment. what's on screen is derived from
// `at`/`lead`/`hold` on every frame, so the whole 48h can be queued up front and
// there is still no server tick and no alarm to drift.
type Cue = {
  id: string;
  kind: "callout" | "banner"; // top-left chip, or the bar across the bottom
  label: string;
  tone: "break" | "recap" | "info";
  at: number | null; // epoch ms target; null = no countdown, just a message
  every: number; // repeat minutes; 0 = one-shot
  lead: number | null; // appears this many minutes ahead; null = as soon as it exists
  hold: number; // minutes it lingers on screen after its moment passes
  show: "off" | "auto" | "on"; // never / on schedule / pinned
};

type State = {
  v: number;
  build: { label: string; endsAt: number | null; remainingMs: number; paused: boolean };
  cues: Cue[];
  sponsor: { caption: string; visible: boolean };
  show: { timer: boolean; logo: boolean };
};

const cue = (c: Partial<Cue> & { id: string; label: string }): Cue => ({
  kind: "callout",
  tone: "info",
  at: null,
  every: 0,
  lead: null,
  hold: 2,
  show: "off",
  ...c,
});

const DEFAULT: State = {
  v: 2,
  build: { label: "build time left", endsAt: null, remainingMs: 48 * 3600_000, paused: true },
  cues: [
    cue({ id: "break", label: "next break", tone: "break" }),
    cue({ id: "recap", label: "next live recap", tone: "recap", every: 30 }),
  ],
  sponsor: { caption: "sheet metal by", visible: true },
  show: { timer: true, logo: true },
};

// v1 kept chips (visible/at/repeat) and a separate ticker; both are cues now.
function migrate(old: any): State {
  if (!old || typeof old !== "object") return DEFAULT;
  if (old.v >= 2) return { ...DEFAULT, ...old };
  const cues: Cue[] = (old.chips ?? []).map((c: any) =>
    cue({
      id: c.id,
      label: c.label,
      tone: c.tone,
      at: c.at ?? null,
      every: c.repeat || 0,
      show: c.visible ? "auto" : "off",
    }),
  );
  if (old.ticker?.text)
    cues.push(
      cue({
        id: "banner",
        kind: "banner",
        label: old.ticker.text,
        show: old.ticker.visible ? "on" : "off",
      }),
    );
  const { chips, ticker, ...rest } = old;
  return { ...DEFAULT, ...rest, v: 2, cues };
}

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
      this.state = migrate(await ctx.storage.get<State>("state"));
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
