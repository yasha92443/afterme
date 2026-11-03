// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import http from "node:http";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { unlink, open } from "node:fs/promises";

async function writePrivateFile(path,value){
  const file=await open(path,'w',0o600);
  try{await file.chmod(0o600);await file.writeFile(value,{encoding:'utf8'});}finally{await file.close();}
}

const clientId = process.env.GMAIL_CLIENT_ID;
const clientSecret = process.env.GMAIL_CLIENT_SECRET;
const port = Number(process.env.GMAIL_OAUTH_PORT || 8789);
const redirectUri = process.env.GMAIL_REDIRECT_URI || `http://127.0.0.1:${port}/oauth2callback`;
const outputPath = process.env.GMAIL_OAUTH_OUTPUT || ".gmail-oauth.local.json";
const authUrlOutputPath = process.env.GMAIL_OAUTH_URL_OUTPUT || ".gmail-oauth-url.local";
const codeOutputPath = process.env.GMAIL_OAUTH_CODE_OUTPUT || ".gmail-oauth-code.local";
const scopes = String(process.env.GMAIL_OAUTH_SCOPES || "https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly")
  .split(/[\s,]+/)
  .map((value) => value.trim())
  .filter(Boolean);
const scope = scopes.join(" ");
const state = randomBytes(24).toString("hex");

if (!clientId || !clientSecret) {
  console.error("Missing GMAIL_CLIENT_ID or GMAIL_CLIENT_SECRET.");
  console.error("PowerShell example:");
  console.error("  $env:GMAIL_CLIENT_ID='your-client-id.apps.googleusercontent.com'");
  console.error("  $env:GMAIL_CLIENT_SECRET='your-client-secret'");
  console.error("  npm run gmail:oauth");
  process.exit(1);
}

const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
authUrl.search = new URLSearchParams({
  client_id: clientId,
  redirect_uri: redirectUri,
  response_type: "code",
  scope,
  access_type: "offline",
  prompt: "consent",
  state,
}).toString();

await writePrivateFile(authUrlOutputPath, authUrl.toString());

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, redirectUri);
    if (url.pathname !== "/oauth2callback") {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    if (url.searchParams.get("state") !== state) {
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("OAuth state mismatch. Close this page and rerun the script.");
      return;
    }
    const error = url.searchParams.get("error");
    if (error) throw new Error(error);
    const code = url.searchParams.get("code");
    if (!code) throw new Error("Missing authorization code");
    await writePrivateFile(codeOutputPath, code);

    const tokenBody = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    });
    const tokenData = await exchangeToken(tokenBody);
    if (!tokenData.refresh_token) {
      throw new Error('OAuth response did not include a refresh token; reauthorize with consent');
    }

    const result = {
      created_at: new Date().toISOString(),
      scope,
      redirect_uri: redirectUri,
      gmail_client_id: clientId,
      gmail_client_secret: clientSecret,
      gmail_refresh_token: tokenData.refresh_token,
      note: "Keep this file private. It is ignored by git.",
    };
    await writePrivateFile(outputPath, JSON.stringify(result, null, 2));
    await unlink(codeOutputPath).catch(() => {});

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end("<h1>Gmail OAuth complete</h1><p>You can close this tab and return to Codex.</p>");
    console.log(`OAuth complete. Secrets were written to ${outputPath}`);
    console.log("Next: put GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, and GMAIL_REFRESH_TOKEN into Cloudflare secrets.");
    setTimeout(() => server.close(), 500);
  } catch (err) {
    await unlink(codeOutputPath).catch(() => {});
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end('OAuth failed. Return to the terminal and retry authorization.');
    console.error('OAuth failed:', err instanceof Error ? err.message : 'Unknown error');
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Listening on ${redirectUri}`);
  console.log("Open this URL in the Gmail sender account browser profile:");
  console.log(authUrl.toString());
});

async function exchangeToken(body) {
  try {
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const data = await response.json();
    if (!response.ok) throw new Error(`OAuth token exchange failed (${response.status})`);
    return data;
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    console.warn("Node fetch failed; retrying token exchange with curl.");
    return exchangeTokenWithCurl(body.toString());
  }
}

function exchangeTokenWithCurl(body) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.platform === "win32" ? "curl.exe" : "curl", [
      "--silent",
      "--show-error",
      "--request", "POST",
      "--header", "Content-Type: application/x-www-form-urlencoded",
      "--data-binary", "@-",
      "https://oauth2.googleapis.com/token",
    ], { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`curl token exchange failed (${code})`));
        return;
      }
      try {
        const data = JSON.parse(stdout);
        if (data.error) throw new Error('OAuth token exchange rejected by provider');
        resolve(data);
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(body);
  });
}
