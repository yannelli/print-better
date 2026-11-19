// Bindings and secrets that may be absent at runtime even though the generated Env lists some of them.
interface Env {
  /** Cloudflare Email Service send binding; optional and intentionally not declared in wrangler.jsonc. */
  EMAIL?: SendEmail
}
