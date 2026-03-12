# poc-claude — Jira TRD → Code → PR Automation

A Node.js/Express REST API that automates the entire journey from a Jira ticket to a GitHub Pull Request using AI.

When a Jira issue moves to **"Ready to Dev"** status, this app automatically:
1. Fetches the Technical Requirements Document (TRD) from the Jira issue
2. Generates production-ready code using GPT-4o
3. Creates a GitHub branch, commits the generated files, and opens a PR
4. Comments the PR link back on the Jira issue

---

## How it works — the automated pipeline

```
Jira issue status → "Ready to Dev"
         │
         ▼
POST /webhook/jira  (Jira sends HTTP event to ngrok tunnel)
         │
         ▼
Step 1: Fetch TRD
  MCP SSE client → mcp.atlassian.com
  GPT-4o uses Jira MCP tools to read full issue description
         │
         ▼
Step 2: Generate code
  GPT-4o reads TRD → returns JSON with file paths + file contents + PR title/body
         │
         ▼
Step 3: Create GitHub PR
  GitHub REST API:
    - Create branch  (trd/<issue-key>-<timestamp>)
    - Commit each generated file
    - Open Pull Request
         │
         ▼
Step 4: Comment on Jira
  GPT-4o uses Jira MCP comment tool
  Posts "🤖 Auto-generated PR from TRD: <pr-url>" on the original issue
```

---

## API endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Lists all available endpoints |
| GET | `/health` | Liveness check |
| POST | `/chat` | Direct chat with GPT-4o — `{ "message": "..." }` |
| POST | `/jira` | Query Jira in plain English via MCP — `{ "query": "..." }` |
| POST | `/webhook/jira` | Receives Jira issue status-change webhook events |
| GET | `/tunnel-url` | Returns the active ngrok public HTTPS URL |
| GET | `/auth/atlassian` | Starts Atlassian OAuth 2.0 flow (browser redirect) |
| GET | `/oauth/callback` | Handles OAuth code exchange, displays new access token |
| GET | `/debug/check-token` | Tests MCP connection and lists available Jira tools |

---

## Architecture

```
Browser / curl
     │
     ▼
Express app (port 3000)
     │
     ├─ POST /chat        → GPT-4o (direct)
     │
     ├─ POST /jira        → MCP SSE → mcp.atlassian.com
     │                         └─ GPT-4o agentic loop (tool_calls ↔ MCP)
     │
     ├─ POST /webhook/jira → TRD pipeline (async)
     │    ├─ MCP → fetch Jira issue
     │    ├─ GPT-4o → generate code
     │    ├─ GitHub REST API → branch + commits + PR
     │    └─ MCP → comment PR URL on Jira
     │
     ├─ GET /auth/atlassian  → Atlassian OAuth redirect
     ├─ GET /oauth/callback  → token exchange
     └─ GET /tunnel-url      → ngrok admin API

ngrok sidecar (port 4040 admin → public HTTPS tunnel → app:3000)
```

---

## What the `/jira` endpoint does

Send a plain English question about your Jira project:

```bash
curl -s -X POST http://localhost:3000/jira \
  -H "Content-Type: application/json" \
  -d '{"query": "list my open Jira issues"}'
```

Internally it:
1. Connects to Atlassian's remote MCP server over SSE
2. Discovers all available Jira tools (e.g. `search_issues`, `get_issue`, `add_comment`)
3. Runs a GPT-4o agentic loop — GPT decides which tools to call, calls them via MCP, and iterates until it can fully answer your question
4. Returns the final answer in plain text

---

## Environment variables

```
OPENAI_API_KEY=sk-proj-...          # OpenAI key for GPT-4o
NGROK_AUTHTOKEN=...                 # ngrok auth token
ATLASSIAN_CLIENT_ID=...             # Atlassian OAuth app client ID
ATLASSIAN_CLIENT_SECRET=...         # Atlassian OAuth app client secret
ATLASSIAN_TOKEN=eyJ...              # Bearer token (1h TTL — refresh via /auth/atlassian)
GITHUB_TOKEN=ghp_...                # GitHub Personal Access Token (repo scope)
GITHUB_REPO=owner/repo              # Target GitHub repo for generated PRs
GITHUB_BASE_BRANCH=main             # Base branch for PRs (default: main)
AWS_REGION=us-east-1
```

---

## Running locally

```bash
# Direct
npm install
npm start               # node src/index.js
npm run dev             # auto-restart on file changes

# With Docker Compose (app + ngrok sidecar)
docker-compose up --build
docker-compose down
```

---

## Setting up the Jira webhook

1. Get your ngrok public URL: `curl http://localhost:3000/tunnel-url`
2. In Jira: **Settings → System → Webhooks → Create webhook**
3. Set URL to: `https://<your-ngrok-domain>/webhook/jira`
4. Select event: **Issue → updated**
5. Save — now any issue status change fires the webhook

---

## Refreshing the Atlassian token (expires every 1 hour)

1. Visit `http://localhost:3000/auth/atlassian` in a browser
2. Complete Atlassian login and consent
3. Copy the displayed token into `.env` as `ATLASSIAN_TOKEN`
4. Restart the server (`docker-compose down && docker-compose up`)

Or test the current token: `curl http://localhost:3000/debug/check-token`

---

## Creating a good Jira TRD for code generation

For the pipeline to generate useful code, the Jira issue needs a detailed description. Include:

- **What to build** — feature name, purpose
- **Acceptance criteria** — what the code must do
- **Technical requirements** — language, framework, file paths, function signatures
- **Input/output examples** — sample data, expected behavior
- **Dependencies** — packages, APIs, database tables involved

A one-liner description will produce minimal output. A detailed TRD produces complete, working code files.

---

## Tech stack

- **Runtime**: Node.js ≥20, CommonJS
- **Framework**: Express 4
- **AI**: OpenAI SDK v6, GPT-4o
- **MCP**: `@modelcontextprotocol/sdk` v1.0.0 — SSEClientTransport to `mcp.atlassian.com`
- **Auth**: Atlassian OAuth 2.0 (3LO Authorization Code flow)
- **Infra**: AWS ECS Fargate, ECR, CloudWatch Logs, Secrets Manager
- **Tunnel**: ngrok (HTTPS tunnel to local port 3000)

---

## Deploy to AWS ECS

```bash
bash scripts/setup-infra.sh   # one-time infra setup
bash scripts/deploy.sh         # build → push ECR → update ECS service
```
