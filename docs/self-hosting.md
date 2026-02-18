# Self-Hosting

The Memento Protocol API runs on Cloudflare Workers with Turso edge databases. The full source is in `saas/`.

For most users, the [hosted service](https://memento-api.myrakrusemark.workers.dev) is the fastest path — free tier, no infrastructure to manage. Self-hosting makes sense if you need data sovereignty or want to modify the API.

## Prerequisites

- [Cloudflare account](https://dash.cloudflare.com/sign-up) (Workers free tier works)
- [Turso account](https://turso.tech) (free tier: 500 databases, 9GB storage)
- Node.js 18+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/): `npm i -g wrangler`

## Setup

### 1. Create the control plane database

```bash
turso db create memento-control
turso db tokens create memento-control
turso db show memento-control --url
```

Save the URL and token — you'll need them as secrets.

### 2. Create the Vectorize index

```bash
wrangler vectorize create memento-memories --dimensions=384 --metric=cosine
```

This powers semantic search. The API degrades gracefully without it (keyword-only recall), but you'll want it.

### 3. Set secrets

```bash
cd saas
wrangler secret put MEMENTO_DB_URL    # Turso control plane URL
wrangler secret put MEMENTO_DB_TOKEN  # Turso control plane token
wrangler secret put TURSO_API_TOKEN   # Turso Platform API token (for creating workspace DBs)
wrangler secret put TURSO_ORG         # Your Turso organization slug
```

The Turso Platform API token is needed because the API auto-creates a separate database per workspace. Get it from [Turso dashboard > Settings > Platform API Tokens](https://turso.tech/app).

### 4. Deploy

```bash
cd saas
npm install
wrangler deploy
```

Your API is now live at `https://memento-api.<your-subdomain>.workers.dev`.

### 5. Point the MCP server at your instance

In your MCP client config, set the environment variables to your instance:

```json
{
  "env": {
    "MEMENTO_API_KEY": "mp_live_your_key",
    "MEMENTO_API_URL": "https://memento-api.your-subdomain.workers.dev",
    "MEMENTO_WORKSPACE": "my-project"
  }
}
```

## What you get

| Feature | Requires |
|---------|----------|
| Core memory (store, recall, working memory, skip list) | Workers + Turso |
| Semantic search (vector embeddings) | + Vectorize + Workers AI |
| AI consolidation summaries | + Workers AI |
| Scheduled decay + consolidation | Cron triggers (auto-configured in `wrangler.toml`) |

Workers AI and Vectorize are included in the Cloudflare Workers free tier.

## What's different from hosted

- You manage your own Turso databases and Cloudflare account
- You handle upgrades by pulling from the repo and redeploying
- No usage dashboard at hifathom.com (you'd use Cloudflare's dashboard)
- Signup endpoint creates keys in your control plane database
