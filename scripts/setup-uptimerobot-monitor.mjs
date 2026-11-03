// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";

const email = process.env.UPTIMEROBOT_ALERT_EMAIL;
const monitorUrl = process.env.UPTIMEROBOT_MONITOR_URL;

if (!email || !monitorUrl) {
  console.error("Set UPTIMEROBOT_ALERT_EMAIL and UPTIMEROBOT_MONITOR_URL first.");
  process.exit(1);
}

const challengeUrl = new URL("https://api.uptimerobot.com/agentic/agent-monitor/challenge");
challengeUrl.searchParams.set("email", email);
challengeUrl.searchParams.set("url", monitorUrl);
const challenge = await curlJson(challengeUrl.toString());
const counter = solveProofOfWork(challenge.nonce, challenge.difficulty);
const result = await curlJson("https://api.uptimerobot.com/agentic/agent-monitor", {
  email,
  url: monitorUrl,
  nonce: challenge.nonce,
  timestamp: challenge.timestamp,
  counter,
  signature: challenge.signature,
});

console.log(JSON.stringify({
  submitted: true,
  status: result.status,
  message: result.message,
  monitor_url: monitorUrl,
}, null, 2));

function solveProofOfWork(nonce, difficulty) {
  for (let counter = 0; ; counter += 1) {
    const hash = createHash("sha256").update(`${nonce}|${counter}`).digest();
    if (leadingZeroBits(hash) >= difficulty) return counter;
  }
}

function leadingZeroBits(buffer) {
  let bits = 0;
  for (const byte of buffer) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    return bits + Math.clz32(byte) - 24;
  }
  return bits;
}

function curlJson(url, body) {
  return new Promise((resolve, reject) => {
    const args = ["--silent", "--show-error", "--fail-with-body"];
    if (body) {
      args.push(
        "--request", "POST",
        "--header", "Content-Type: application/json",
        "--data-binary", "@-",
      );
    }
    args.push(url);
    const child = spawn(process.platform === "win32" ? "curl.exe" : "curl", args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`UptimeRobot request failed (${code}); provider response omitted`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(body ? JSON.stringify(body) : undefined);
  });
}
