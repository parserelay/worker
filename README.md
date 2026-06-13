# @parserelay/worker

The self-hostable **ParseRelay scan worker** — the open scan core. One `POST /v1/scan`
call takes a document image in and returns structured, confidence-scored data. Bring
your own model/OCR keys; **no database required.**

Runs on Cloudflare Workers (Hono). Deploy it to your own account and you own the whole
path — your keys, your infrastructure, your data.

## Deploy it yourself

```sh
pnpm install
npx wrangler secret put ANTHROPIC_API_KEY     # and/or OPENAI_API_KEY
npx wrangler secret put GLM_OCR_API_KEY        # or MISTRAL_API_KEY
npx wrangler secret put API_KEYS               # comma-separated keys you accept
npx wrangler deploy
```

That's it — `POST /v1/scan` is live. No accounts, no billing.

```sh
curl https://<your-worker>/v1/scan \
  -H "authorization: Bearer <one-of-your-API_KEYS>" \
  -H "content-type: application/json" \
  -d '{"image":"data:image/png;base64,...","schema":["merchant","total","date"]}'
```

Access control is `API_KEYS` only — there's no built-in rate limiting or spend cap in
the core; put it behind your own gateway if you need quotas. See `wrangler.toml` for the
full set of secrets and the optional async-relay bindings.

## Compose it (library)

The package also exports the scan pipeline, so you can build a richer worker around it —
adding your own accounts, metering, or key management by passing a `ControlPlaneAdapter`:

```ts
import { createScanApp, type ControlPlaneAdapter } from "@parserelay/worker";

// Zero-config self-host:
export default { fetch: createScanApp().fetch };

// Or inject your own control plane and mount your own routes:
const app = createScanApp(myAdapter);
app.route("/v1", myOwnRoutes);
```
