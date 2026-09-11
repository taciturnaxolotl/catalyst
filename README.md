# catalyst

![the overlay](docs/preview.png)

OBS stream overlay for FRC 4611 Ozone Robotics' FTC RI48H build, "Catalyst" — a 48-hour build
clock, callouts the operator can conjure mid-stream ("next break in 20 min"), a sponsor block
and the team mark. runs on cloudflare workers.

a Worker plus one Durable Object holds the state, and every open tab (OBS browser source,
operator panel, anyone's phone) keeps a hibernating websocket to it, so an edit is on screen in
roughly one RTT.

```
bun install
bun run dev                  # http://localhost:8787 — local DO, no network needed
bun run deploy
bunx wrangler secret put CONTROL_KEY
```

## routes

| path | what |
| --- | --- |
| `/` | overlay — transparent, 1920x1080 stage, auto-scales to the browser source |
| `/control?key=…` | operator panel; the key is cached in localStorage so the dock URL can be bookmarked |
| `/ws` | state socket. no key = read-only |
| `/state` | `GET` current, `POST` a partial state (deep-merged, arrays replace) |

static files come from the assets binding (`public/`), the Worker only handles `/ws` and
`/state`, so the overlay html, logos and fonts are served from cache at the edge.

## before you go live

set `CONTROL_KEY` as a secret (locally, copy `.dev.vars.example` to `.dev.vars`). **with no secret set, every visitor is an operator** — that's
deliberate for `wrangler dev`, and a bad time if someone finds the URL during a stream.

```bash
bunx wrangler secret put CONTROL_KEY
```

`/state` POSTs need `?key=…` or an `x-control-key` header; a websocket without the key is
tagged `view` and its frames get dropped server-side.

worth putting it on a subdomain you already own (route `catalyst.dunkirk.sh/*`) so the OBS
source URL is memorable at 4am.

## obs wiring

1. **Sources → + → Browser**, URL `https://catalyst.<your-domain>/`, 1920x1080, leave
   "shutdown when not visible" off.
2. **Docks → Custom Browser Docks**, URL `https://catalyst.<your-domain>/control?key=…`.

## clock and callouts

`load` parks a duration, `start` stamps an absolute `endsAt`. the countdown is derived from
that timestamp on every frame, so a refreshed browser source, an OBS restart, or a laptop
reboot all pick up exactly where the clock actually is. `pause` folds the remainder back into
state. ± shifts whichever of the two is live.

callouts render as "next break in 20 min" — `45s` / `20 min` / `1h 05m` / `now`, blinking under
a minute, self-removing 2 minutes after they lapse.

- **in** — now + n minutes. the 3am path: type `20`, hit `in`.
- **at** — a wall clock time, rolling to tomorrow if it's already past.
- **min loop** — `30` means it repeats. the roll is computed from `at + k·repeat`, a pure
  function of the stored state, so there's no server tick, no alarm, and a tab that wakes from
  hibernation lands on the same target as everyone else.

every broadcast carries the DO's `Date.now()`, and clients keep a skew offset from it. a phone
with a wrong clock setting a break for "in 20 min" still lands on the right second on stream.

## state api

```bash
K=your-key
curl -X POST "https://catalyst.example/state?key=$K" -d '{"ticker":{"text":"drivetrain v2 on the router","visible":true}}'
curl -X POST "https://catalyst.example/state?key=$K" -d '{"show":{"timer":false,"logo":false},"sponsor":{"visible":false}}'
curl https://catalyst.example/state
```

good enough to drive from a stream deck without opening the panel.

## if the venue wifi dies

`bun run dev` is the same worker against a local durable object, so the whole thing runs off
the build laptop with no uplink. point the browser source at `http://localhost:8787/` and
nothing else changes.

## cost

one DO instance, sqlite-backed (the class kind the free plan allows). websocket hibernation
means no duration billing while nobody's touching the panel, and a 48-hour show is a few
thousand requests. it fits in the free tier.

## swapping assets

`public/assets/` — `oshcut.png` (sponsor, 240px wide on screen), `ozone-logo.png` (corner,
210px); `ozone-gear.png` and `ozone-wordmark-white.png` are spares. palette is sampled off the
team logo and sits at the top of `public/index.html`: navy `#003087`, silver `#a5a8bc`,
green `#25b001`.

pushing to `main` deploys via `.github/workflows/deploy.yml` — needs a `CLOUDFLARE_API_TOKEN`
repo secret with the *Edit Cloudflare Workers* template.

MIT. the Ozone 4611 and OshCut marks in `public/assets/` are their owners' and aren't covered
by it.
