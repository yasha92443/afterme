// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
export function parseEpigraph(value) {
  const lines = String(value ?? "").replaceAll("\r", "").split("\n");
  while (lines.length && !lines.at(-1).trim()) lines.pop();

  const lastLine = lines.at(-1)?.trim() || "";
  const attribution = lastLine.match(/^(?:[—–-]\s*)+(.+)$/u);
  if (!attribution) {
    return { quote: lines.join("\n").trim(), source: "" };
  }

  lines.pop();
  return {
    quote: lines.join("\n").trim(),
    source: attribution[1].trim(),
  };
}
