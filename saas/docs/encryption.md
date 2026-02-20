# Encryption at Rest

Memento SaaS uses AES-256-GCM envelope encryption to protect sensitive data at rest.

## Architecture

```
Master Key (env secret, 32 bytes)
    └── wraps → Workspace Key (random, per-workspace, 32 bytes)
                    └── encrypts → Individual field values
```

- **Master key**: A single 256-bit key stored as a Cloudflare Workers secret (`ENCRYPTION_MASTER_KEY`). Used only to wrap/unwrap workspace keys.
- **Workspace keys**: Each workspace gets its own random 256-bit AES-GCM key, generated on first use. The workspace key is wrapped (encrypted) with the master key and stored in the `workspaces.encrypted_key` column.
- **Field encryption**: Sensitive text fields are encrypted with the workspace key before storage and decrypted on read.

## What is encrypted

| Table | Encrypted fields | Not encrypted |
|-------|-----------------|---------------|
| `memories` | `content` | id, type, tags, timestamps, relevance, access_count |
| `identity_snapshots` | `crystal` | id, source_count, created_at |
| `working_memory_items` | `title`, `content`, `next_action` | id, category, status, priority, tags, timestamps |
| `working_memory_sections` | `content` | section_key, heading, updated_at |
| `skip_list` | `item`, `reason` | id, expires_at, added_at |
| `consolidations` | `summary`, `template_summary` | id, source_ids, tags, type, method, created_at |

**Not encrypted by design**: IDs, timestamps, tags, type/category/status fields, and numeric fields. These must remain queryable at the database level.

## Encrypted field format

Encrypted values are prefixed with `enc:` for easy detection:

```
enc:<base64(12-byte IV)>:<base64(ciphertext + GCM auth tag)>
```

Plaintext values (without the `enc:` prefix) pass through decryption unchanged. This enables gradual migration and backwards compatibility.

## Key management

- Master key: Set via `wrangler secret put ENCRYPTION_MASTER_KEY` (64 hex chars).
  Generate with: `openssl rand -hex 32`
- Workspace keys are auto-generated on first use and cached in-memory per worker lifecycle.
- Key rotation: Replace the master key and re-wrap all workspace keys (not yet automated).

## Migration

For existing workspaces with plaintext data, use the admin endpoint:

```
POST /v1/admin/encrypt-workspace
Authorization: Bearer <api-key>
X-Memento-Workspace: <workspace-name>
```

This is idempotent — records with the `enc:` prefix are skipped.

## Development / Testing

In development and test environments (when `ENCRYPTION_MASTER_KEY` is not set), a hardcoded dev key is used automatically. This key is `0000...0000` (32 zero bytes) and must never be used in production.

## Vector search

Plaintext content is sent to the vector embedding service (Cloudflare Vectorize) for semantic search. The embeddings themselves are not reversible to the original text, but the Vectorize index does contain vector representations of the content.
