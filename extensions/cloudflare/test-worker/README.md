# duplo-watch-demo — test Worker for CloudflareWatch

Throwaway Worker used to exercise `extensions/cloudflare`. It isn't shipped in the bundle; `build-extension.sh` only
packs `dist/backend`, `frontend/dist` and `skills/`.

```bash
cd extensions/cloudflare/test-worker
npx wrangler login                       # browser OAuth, once (your own Cloudflare login — not the read-only token)
npx wrangler deploy --message "v1 initial"                                   # → ScriptAdded (or baseline)
npx wrangler deploy --var APP_VERSION:2 --message "v2 redeploy test"         # → one Deployed event, message "v2 redeploy test"
npx wrangler deploy --name duplo-watch-demo-2 --message "second worker"      # → ScriptAdded duplo-watch-demo-2
npx wrangler delete --name duplo-watch-demo-2                                # → ScriptDeleted
```

Each change should appear exactly once in the watch's **Activity** tab within about 5 minutes (one `DriftCadence`).
