'use strict';

// Polyfill EventSource for MCP SDK — injects Atlassian auth header on SSE GET
const _OriginalEventSource = require('eventsource');
global.EventSource = class EventSource extends _OriginalEventSource {
  constructor(url, init = {}) {
    if (String(url).includes('mcp.atlassian.com') && process.env.ATLASSIAN_TOKEN) {
      init = { ...init, headers: { Authorization: `Bearer ${process.env.ATLASSIAN_TOKEN}`, ...init.headers } };
    }
    super(url, init);
  }
};

// Patch global fetch — injects Atlassian auth header on MCP POST requests
const _origFetch = global.fetch;
global.fetch = function (url, opts = {}) {
  if (String(url).includes('mcp.atlassian.com') && process.env.ATLASSIAN_TOKEN) {
    opts = { ...opts, headers: { Authorization: `Bearer ${process.env.ATLASSIAN_TOKEN}`, ...opts.headers } };
  }
  return _origFetch(url, opts);
};

const express = require('express');
const OpenAI = require('openai');

require('dotenv').config();
console.log(':mag: Environment variables loaded:');
console.log('- OPENAI_API_KEY:', process.env.OPENAI_API_KEY ? ':white_check_mark: Set' : ':x: Missing');
console.log('- ATLASSIAN_TOKEN:', process.env.ATLASSIAN_TOKEN ? ':white_check_mark: Set' : ':x: Missing');
console.log('- ATLASSIAN_CLIENT_ID:', process.env.ATLASSIAN_CLIENT_ID ? ':white_check_mark: Set' : ':x: Missing');
console.log('- ATLASSIAN_CLIENT_SECRET:', process.env.ATLASSIAN_CLIENT_SECRET ? ':white_check_mark: Set' : ':x: Missing');
console.log('- GITHUB_TOKEN:', process.env.GITHUB_TOKEN ? ':white_check_mark: Set' : ':x: Missing');
console.log('- GITHUB_REPO:', process.env.GITHUB_REPO ? ':white_check_mark: Set' : ':x: Missing');
console.log('- PORT:', process.env.PORT || '3000 (default)');
const app = express();
app.use(express.json());

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const PORT = process.env.PORT || 3000;
const NGROK_API_HOST = process.env.NGROK_API_HOST || 'localhost';

app.get('/', (_req, res) => {
  res.json({
    endpoints: {
      'GET  /health': 'liveness check',
      'POST /chat': 'chat with GPT — body: { "message": "..." }',
      'POST /jira': 'query Atlassian via MCP — body: { "query": "..." }',
      'POST /webhook/jira': 'receives Jira status-change webhook events',
      'GET  /tunnel-url': 'active ngrok public URL',
    },
  });
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── Chat endpoint ─────────────────────────────────────────────────────────────
app.post('/chat', async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'message field is required' });

    const response = await client.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: message }],
    });

    const choice = response.choices[0];
    res.json({
      reply: choice.message.content,
      model: response.model,
      usage: response.usage,
    });
  } catch (error) {
    console.error('Chat error:', error.message);
    res.status(500).json({ error: error.message });
  }
});
// 👇 ADD THE NEW CODE RIGHT HERE 👇
app.get('/auth/atlassian', (req, res) => {
  const clientId = process.env.ATLASSIAN_CLIENT_ID;

  if (!clientId) {
    return res.status(500).send('ATLASSIAN_CLIENT_ID not set in .env');
  }
  const redirectUri = `http://localhost:${PORT}/oauth/callback`;

  // Build the authorization URL with all required scopes
  const authUrl = `https://auth.atlassian.com/authorize?` +
    `audience=api.atlassian.com&` +
    `client_id=${clientId}&` +
    `scope=read:jira-work%20write:jira-work%20offline_access&` +  // offline_access is key!
    `redirect_uri=${encodeURIComponent(redirectUri)}&` +
    `response_type=code&` +
    `prompt=consent`;
  console.log('Redirecting to Atlassian for authorization...');
  res.redirect(authUrl);
});

// ── Atlassian OAuth 2.0 callback ──────────────────────────────────────────────
app.get('/oauth/callback', async (req, res) => {
  const { code, error } = req.query;

  if (error) return res.status(400).send(`OAuth error: ${error}`);
  if (!code) return res.status(400).send('Missing code parameter');

  const clientId = process.env.ATLASSIAN_CLIENT_ID;
  const clientSecret = process.env.ATLASSIAN_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return res.status(500).send('ATLASSIAN_CLIENT_ID or ATLASSIAN_CLIENT_SECRET not set in .env');
  }

  try {
    const tokenRes = await fetch('https://auth.atlassian.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: `http://localhost:${PORT}/oauth/callback`,
      }),
    });
    console.log('🔍 OAuth Debug:');
    console.log('- Response status:', tokenRes.status);

    const data = await tokenRes.json();
    console.log('- Response data:', JSON.stringify(data, null, 2));
    // Check if we got a refresh token
    if (data.refresh_token) {
      console.log('✅ Refresh token received!');
    } else {
      console.log('⚠️ No refresh token - offline_access scope might be missing');
    }
    if (!tokenRes.ok) {
      console.log('❌ OAuth error:', data);
      return res.status(400).json({ error: data });
    }

    if (!tokenRes.ok) return res.status(400).json({ error: data });

    res.send(`
      <h2>✅ Atlassian OAuth success!</h2>
      <p>Copy the token below into <code>.env</code> as <code>ATLASSIAN_TOKEN</code>:</p>
      <textarea rows="4" cols="80" onclick="this.select()">${data.access_token}</textarea>
      <br/><br/>
      <b>Expires in:</b> ${data.expires_in}s<br/>
      ${data.refresh_token ? '<p>✅ Refresh token received - token will be refreshable</p>' : '<p>⚠️ No refresh token - token will expire in 1 hour</p>'}
      <p>Restart the server and test <code>POST /jira</code>.</p>
    `);
  } catch (err) {
    console.error('OAuth catch error:', err);
    res.status(500).send(`Token exchange failed: ${err.message}`);
  }
});

// ── Jira / Atlassian via MCP + OpenAI agentic loop ────────────────────────────
// Connects to https://mcp.atlassian.com/v1/sse, discovers tools,
// then runs an OpenAI function-calling loop until the query is answered.
app.post('/jira', async (req, res) => {
  try {
    const { query } = req.body;
    if (!query) return res.status(400).json({ error: 'query field is required' });

    const token = process.env.ATLASSIAN_TOKEN;
    if (!token) return res.status(500).json({ error: 'ATLASSIAN_TOKEN not set in .env' });

    // Intercept fetch to log what headers MCP SDK sends to Atlassian
    const _origFetch = global.fetch;
    global.fetch = function (url, opts = {}) {
      if (String(url).includes('mcp.atlassian.com')) {
        console.log('[FETCH] URL:', String(url).substring(0, 100));
        console.log('[FETCH] headers:', JSON.stringify(opts.headers || {}));
      }
      return _origFetch(url, opts);
    };

    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js');

    const authHeaders = { Authorization: `Bearer ${token}` };
    const transport = new SSEClientTransport(
      new URL('https://mcp.atlassian.com/v1/sse'),
      { eventSourceInit: { headers: authHeaders }, requestInit: { headers: authHeaders } }
    );

    const mcpClient = new Client({ name: 'claude-ecs-app', version: '1.0.0' }, { capabilities: {} });
    await mcpClient.connect(transport);

    const { tools } = await mcpClient.listTools();
    console.log(`[MCP] Connected — ${tools.length} Atlassian tools available`);

    if (tools.length === 0) {
      await mcpClient.close();
      return res.status(401).json({
        error: 'No Atlassian tools found — ATLASSIAN_TOKEN has likely expired (1h TTL). Re-run the OAuth flow: open the authorize URL in a browser, then GET /oauth/callback will refresh your token.',
      });
    }

    // Convert MCP tool schema → OpenAI function tool format
    const openAiTools = tools.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    }));

    // Agentic loop: GPT calls tools until it can fully answer the query
    const messages = [{ role: 'user', content: query }];

    while (true) {
      const response = await client.chat.completions.create({
        model: 'gpt-4o',
        tools: openAiTools,
        messages,
      });

      const choice = response.choices[0];
      messages.push(choice.message);

      if (choice.finish_reason === 'stop') {
        await mcpClient.close();
        return res.json({ reply: choice.message.content, usage: response.usage });
      }

      if (choice.finish_reason === 'tool_calls') {
        for (const toolCall of choice.message.tool_calls) {
          console.log(`[MCP] Calling tool: ${toolCall.function.name}`);
          const result = await mcpClient.callTool({
            name: toolCall.function.name,
            arguments: JSON.parse(toolCall.function.arguments),
          });
          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: result.content[0]?.text ?? '',
          });
        }
        continue;
      }

      break;
    }

    await mcpClient.close();
    res.status(500).json({ error: 'Unexpected loop exit' });

  } catch (error) {
    global.fetch = global.fetch._orig || global.fetch;
    console.error('[MCP] Jira error:', error.message);
    res.status(500).json({ error: error.message });
  }
});
app.get('/debug/check-token', async (req, res) => {
  try {
    const token = process.env.ATLASSIAN_TOKEN;
    if (!token) {
      return res.json({ error: 'No ATLASSIAN_TOKEN found in env' });
    }
    console.log('🔍 Testing MCP connection...');
    // Test the MCP SSE connection directly
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js');
    const authHeaders = {
      Authorization: `Bearer ${token}`,
      "X-Atlassian-Cloud-Id": process.env.ATLASSIAN_CLOUD_ID
    };

    const transport = new SSEClientTransport(
      new URL("https://mcp.atlassian.com/v1/sse"),
      {
        eventSourceInit: { headers: authHeaders },
        requestInit: { headers: authHeaders }
      }
    );
    const mcpClient = new Client({ name: 'debug-client', version: '1.0.0' }, { capabilities: {} });

    // Try to connect with a timeout
    const connectPromise = mcpClient.connect(transport);
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Connection timeout')), 10000)
    );
    await Promise.race([connectPromise, timeoutPromise]);

    const { tools } = await mcpClient.listTools();

    await mcpClient.close();
    res.json({
      valid: true,
      toolsFound: tools.length,
      tools: tools.map(t => t.name),
      message: 'Successfully connected to MCP server'
    });
  } catch (error) {
    console.error('MCP test error:', error);

    // Check for specific error types
    if (error.message.includes('401')) {
      res.json({
        valid: false,
        error: 'Token expired or invalid',
        details: error.message
      });
    } else if (error.message.includes('ECONNREFUSED')) {
      res.json({
        valid: false,
        error: 'Cannot connect to MCP server',
        details: error.message
      });
    } else {
      res.json({
        valid: false,
        error: error.message,
        type: error.constructor.name
      });
    }
  }
});
// ── Jira Webhook receiver ─────────────────────────────────────────────────────
// Configure in Jira: Settings → System → Webhooks → Create webhook
// URL: https://<your-ngrok-domain>/webhook/jira
// Events: Issue → updated
app.post('/webhook/jira', (req, res) => {
  const { webhookEvent, issue, changelog } = req.body;

  if (webhookEvent !== 'jira:issue_updated') {
    return res.status(200).json({ ignored: true, reason: 'not an issue_updated event' });
  }

  const statusChange = changelog?.items?.find(item => item.field === 'status');
  if (!statusChange) {
    return res.status(200).json({ ignored: true, reason: 'no status change in this update' });
  }

  // Only trigger pipeline when status moves to "Ready to Dev"
  const toStatus = statusChange.toString;

  if (toStatus?.toLowerCase() !== 'ready to dev') {
    console.log(`[Webhook] Ignored — status changed to "${toStatus}"`);
    return res.status(200).json({
      ignored: true,
      reason: `status is "${toStatus}", waiting for "Ready to Dev"`
    });
  }

  const issueKey = issue?.key;
  console.log(`[Webhook] "${issueKey}" moved to Ready to Dev — starting TRD → Code → PR pipeline`);

  // Respond immediately so Jira doesn't time out, then run pipeline async
  res.status(200).json({ received: true, issueKey, pipeline: 'started' });

  runTrdPipeline(issueKey).catch(err =>
    console.error(`[Pipeline] Error for ${issueKey}:`, err.message)
  );
});

// ── TRD → Code → GitHub PR pipeline ─────────────────────────────────────────
async function runTrdPipeline(issueKey) {
  const token = process.env.ATLASSIAN_TOKEN;
  if (!token) { console.error('[Pipeline] ATLASSIAN_TOKEN not set'); return; }

  const githubToken = process.env.GITHUB_TOKEN;
  const githubRepo = process.env.GITHUB_REPO;
  const baseBranch = process.env.GITHUB_BASE_BRANCH || 'main';
  if (!githubToken || !githubRepo) { console.error('[Pipeline] GITHUB_TOKEN or GITHUB_REPO not set'); return; }

  // ── Step 1: Fetch full issue (TRD) from Jira via MCP ──────────────────────
  console.log(`[Pipeline] Fetching TRD for ${issueKey}...`);
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js');

  const authHeaders = { Authorization: `Bearer ${token}` };
  const transport = new SSEClientTransport(
    new URL('https://mcp.atlassian.com/v1/sse'),
    { eventSourceInit: { headers: authHeaders }, requestInit: { headers: authHeaders } }
  );
  const mcpClient = new Client({ name: 'trd-pipeline', version: '1.0.0' }, { capabilities: {} });
  await mcpClient.connect(transport);

  const { tools } = await mcpClient.listTools();
  if (tools.length === 0) {
    await mcpClient.close();
    console.error('[Pipeline] No MCP tools — ATLASSIAN_TOKEN likely expired');
    return;
  }

  // Use GPT-4o with MCP tools to fetch the full issue description (TRD)
  const openAiTools = tools.map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));

  const fetchMessages = [{
    role: 'user',
    content: `Fetch the full details of Jira issue ${issueKey}, including its description, acceptance criteria, and any technical requirements. Return the complete content as-is.`,
  }];

  let trdContent = '';
  while (true) {
    const response = await client.chat.completions.create({ model: 'gpt-4o', tools: openAiTools, messages: fetchMessages });
    const choice = response.choices[0];
    fetchMessages.push(choice.message);
    if (choice.finish_reason === 'stop') { trdContent = choice.message.content; break; }
    if (choice.finish_reason === 'tool_calls') {
      for (const toolCall of choice.message.tool_calls) {
        const result = await mcpClient.callTool({ name: toolCall.function.name, arguments: JSON.parse(toolCall.function.arguments) });
        fetchMessages.push({ role: 'tool', tool_call_id: toolCall.id, content: result.content[0]?.text ?? '' });
      }
    } else break;
  }

  console.log(`[Pipeline] TRD fetched for ${issueKey} (${trdContent.length} chars)`);

  // ── Step 2: Generate code from TRD using GPT-4o ───────────────────────────
  console.log(`[Pipeline] Generating code from TRD...`);
  const codeResponse = await client.chat.completions.create({
    model: 'gpt-4o',
    messages: [{
      role: 'system',
      content: `You are a senior software engineer. Given a Jira TRD (Technical Requirements Document), generate clean, production-ready code that implements the requirements.
Return ONLY a JSON object in this format (no markdown, no explanation outside the JSON):
{
  "files": [
    { "path": "src/example.js", "content": "// code here" }
  ],
  "prTitle": "feat(ISSUE-KEY): short description",
  "prBody": "## Summary\\n- what was implemented\\n\\n## Jira\\n[ISSUE-KEY](link)"
}`,
    }, {
      role: 'user',
      content: `Jira Issue: ${issueKey}\n\nTRD Content:\n${trdContent}`,
    }],
  });

  let generated;
  try {
    generated = JSON.parse(codeResponse.choices[0].message.content);
  } catch {
    console.error('[Pipeline] GPT response was not valid JSON, wrapping as single file');
    generated = {
      files: [{ path: `src/${issueKey.toLowerCase().replace('-', '_')}.js`, content: codeResponse.choices[0].message.content }],
      prTitle: `feat(${issueKey}): generated from TRD`,
      prBody: `Auto-generated from Jira TRD for ${issueKey}`,
    };
  }

  console.log(`[Pipeline] Code generated — ${generated.files.length} file(s)`);

  // ── Step 3: Create GitHub branch, commit files, open PR ───────────────────
  const branchName = `trd/${issueKey.toLowerCase()}-${Date.now()}`;
  const ghHeaders = { Authorization: `Bearer ${githubToken}`, 'Content-Type': 'application/json', Accept: 'application/vnd.github+json' };
  const ghBase = `https://api.github.com/repos/${githubRepo}`;

  // Get base branch SHA
  const refRes = await fetch(`${ghBase}/git/ref/heads/${baseBranch}`, { headers: ghHeaders });
  const refData = await refRes.json();
  const baseSha = refData.object?.sha;
  if (!baseSha) { console.error('[Pipeline] Could not get base branch SHA:', refData.message); await mcpClient.close(); return; }

  // Create new branch
  await fetch(`${ghBase}/git/refs`, {
    method: 'POST', headers: ghHeaders,
    body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha: baseSha }),
  });
  console.log(`[Pipeline] Created branch: ${branchName}`);

  // Commit each file
  for (const file of generated.files) {
    const existingRes = await fetch(`${ghBase}/contents/${file.path}?ref=${baseBranch}`, { headers: ghHeaders });
    const existingData = existingRes.ok ? await existingRes.json() : null;

    await fetch(`${ghBase}/contents/${file.path}`, {
      method: 'PUT', headers: ghHeaders,
      body: JSON.stringify({
        message: `feat(${issueKey}): add ${file.path}`,
        content: Buffer.from(file.content).toString('base64'),
        branch: branchName,
        ...(existingData?.sha ? { sha: existingData.sha } : {}),
      }),
    });
    console.log(`[Pipeline] Committed: ${file.path}`);
  }

  // Open PR
  const prRes = await fetch(`${ghBase}/pulls`, {
    method: 'POST', headers: ghHeaders,
    body: JSON.stringify({ title: generated.prTitle, body: generated.prBody, head: branchName, base: baseBranch }),
  });
  const prData = await prRes.json();
  const prUrl = prData.html_url;
  console.log(`[Pipeline] PR created: ${prUrl}`);

  // ── Step 4: Comment PR link back on the Jira issue ────────────────────────
  const commentTool = tools.find(t => t.name.includes('comment') || t.name.includes('add_comment'));
  if (commentTool && prUrl) {
    const commentMessages = [{
      role: 'user',
      content: `Add a comment to Jira issue ${issueKey} with this exact text: "🤖 Auto-generated PR from TRD: ${prUrl}"`,
    }];
    while (true) {
      const r = await client.chat.completions.create({ model: 'gpt-4o', tools: openAiTools, messages: commentMessages });
      const c = r.choices[0];
      commentMessages.push(c.message);
      if (c.finish_reason === 'stop') break;
      if (c.finish_reason === 'tool_calls') {
        for (const toolCall of c.message.tool_calls) {
          const result = await mcpClient.callTool({ name: toolCall.function.name, arguments: JSON.parse(toolCall.function.arguments) });
          commentMessages.push({ role: 'tool', tool_call_id: toolCall.id, content: result.content[0]?.text ?? '' });
        }
      } else break;
    }
    console.log(`[Pipeline] Commented PR link on ${issueKey}`);
  }

  await mcpClient.close();
  console.log(`[Pipeline] Done for ${issueKey} → ${prUrl}`);
}

// ── ngrok tunnel URL ──────────────────────────────────────────────────────────
app.get('/tunnel-url', async (_req, res) => {
  try {
    const response = await fetch(`http://${NGROK_API_HOST}:4040/api/tunnels`);
    const data = await response.json();
    const httpsUrl =
      data.tunnels?.find(t => t.proto === 'https')?.public_url ||
      data.tunnels?.[0]?.public_url || null;
    res.json({ url: httpsUrl });
  } catch {
    res.json({ url: null, message: 'ngrok API not reachable' });
  }
});

app.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
});