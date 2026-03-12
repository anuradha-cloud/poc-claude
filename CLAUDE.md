# CLAUDE.md — poc-claude

## What this project is

A Node.js/Express REST API that lets you query Jira in plain English.
It connects to the Atlassian remote MCP server, discovers Jira tools automatically,
then runs a GPT-4o agentic loop to answer your question.

Deployed as a Docker container on AWS ECS Fargate with an ngrok sidecar for public tunnel access.

---

## Architecture

```
Browser / curl
     │
     ▼
Express app (port 3000)
     │
     ├─ POST /chat       → OpenAI GPT-4o (direct)
     │
     ├─ POST /jira       → MCP SSE client → mcp.atlassian.com
     │                        └─ GPT-4o agentic loop (tool_calls ↔ MCP)
     │
     ├─ GET /oauth/callback → Atlassian OAuth 2.0 token exchange
     │
     └─ GET /tunnel-url  → ngrok API (http://ngrok:4040 or localhost:4040)

ngrok sidecar (port 4040 admin, public HTTPS tunnel → app:3000)
```

---

## Key files

| File | Purpose |
|---|---|
| `src/index.js` | Main app — all routes live here (CJS) |
| `package.json` | Dependencies; no `"type": "module"` (CJS) |
| `.env` | Secrets — never committed |
| `.env.example` | Template for required env vars |
| `Dockerfile` | `node:20-alpine`, non-root user, port 3000 |
| `docker-compose.yml` | Local dev: `app` + `ngrok` services |
| `ecs/task-definition.json` | Fargate task — app + ngrok containers |
| `scripts/setup-infra.sh` | One-time AWS infra setup (ECR, ECS, IAM, Secrets Manager) |
| `scripts/deploy.sh` | Build → push ECR → register task → update ECS service |

---

## Environment variables

```
OPENAI_API_KEY=sk-proj-...          # OpenAI key (GPT-4o)
NGROK_AUTHTOKEN=...                 # ngrok auth token
ATLASSIAN_CLIENT_ID=...             # Atlassian OAuth app client ID
ATLASSIAN_CLIENT_SECRET=...         # Atlassian OAuth app client secret
ATLASSIAN_TOKEN=eyJ...              # Bearer token (1h TTL — refresh via OAuth flow)
AWS_REGION=us-east-1
```

---

## Running locally

```bash
# Direct (no Docker)
npm install
npm start           # node src/index.js
npm run dev         # node --watch src/index.js (auto-restart)

# With Docker Compose (app + ngrok)
docker-compose up --build
docker-compose down
```

---

## Testing endpoints

```bash
# Health
curl http://localhost:3000/health

# Chat
curl -s -X POST http://localhost:3000/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello!"}'

# Jira query (requires valid ATLASSIAN_TOKEN)
curl -s -X POST http://localhost:3000/jira \
  -H "Content-Type: application/json" \
  -d '{"query": "list my open Jira issues"}'

# Tunnel URL
curl http://localhost:3000/tunnel-url
```

---

## Atlassian OAuth flow (refresh token)

The `ATLASSIAN_TOKEN` expires after **1 hour**. To refresh:

1. Open this URL in a browser:
   ```
   https://auth.atlassian.com/authorize?audience=api.atlassian.com&client_id=ir754biZab6cJaD06pdJcaebwj4ydDdz&scope=read%3Ajira-work%20read%3Ajira-user&redirect_uri=http%3A%2F%2Flocalhost%3A3000%2Foauth%2Fcallback&response_type=code&prompt=consent
   ```
2. Complete Atlassian login/consent
3. The `/oauth/callback` endpoint exchanges the code and displays the new token
4. Copy the token into `.env` as `ATLASSIAN_TOKEN`
5. Restart the server

---

## Tech stack

- **Runtime**: Node.js ≥20, CommonJS (`require`)
- **Framework**: Express 4
- **AI**: OpenAI SDK v6 (`openai` package), GPT-4o model
- **MCP**: `@modelcontextprotocol/sdk` v1 — SSEClientTransport to `https://mcp.atlassian.com/v1/sse`
- **Infra**: AWS ECS Fargate, ECR, CloudWatch Logs, Secrets Manager
- **Tunnel**: ngrok free account (named domain)

---

## Common issues

| Symptom | Cause | Fix |
|---|---|---|
| `/jira` returns 401 "No Atlassian tools found" | `ATLASSIAN_TOKEN` expired (1h TTL) | Re-run OAuth flow above |
| `/jira` returns 500 "ATLASSIAN_TOKEN not set" | Missing env var | Add token to `.env` and restart |
| GPT answers without using tools | Token expired, tools list was empty | Same as 401 fix above |
| `Cannot GET /` | Server not running | `npm start` |
| ngrok tunnel URL is null | ngrok not running | `docker-compose up` or run ngrok manually |

---

## Deploy to ECS

```bash
# One-time infra setup
bash scripts/setup-infra.sh

# Deploy / redeploy
bash scripts/deploy.sh
```

Requires AWS CLI configured with sufficient IAM permissions (ECR, ECS, Secrets Manager, IAM, CloudWatch).
