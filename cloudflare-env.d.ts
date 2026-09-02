// App-specific bindings augment @opennextjs/cloudflare's CloudflareEnv.
interface CloudflareEnv {
  VAULT_CACHE?: KVNamespace;
  EXPLORER_CACHE?: KVNamespace;
}
