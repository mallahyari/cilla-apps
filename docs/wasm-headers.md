# Multi-Threaded WASM Headers (`COOP` / `COEP`)

`phonon-tts` runs fastest in the browser when multi-threaded WebAssembly (`SharedArrayBuffer`) is enabled.

To enable cross-origin isolation in local dev servers (e.g. Vite) and static hosts (Cloudflare Pages, Vercel, Netlify), serve web apps with:

```http
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

### Shared Model Cache Tip

When deploying multiple web apps from this monorepo under the **same origin** (for example, `https://apps.example.com/app-a/` and `https://apps.example.com/app-b/`), the browser caches the 107 MB Cilla Mini model once and reuses it across every app.
