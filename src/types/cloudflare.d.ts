// Extend the CloudflareEnv from @opennextjs/cloudflare
declare global {
  interface CloudflareEnv {
    VAULT_CACHE?: KVNamespace;
    EXPLORER_CACHE?: KVNamespace;
  }
}

export {};
