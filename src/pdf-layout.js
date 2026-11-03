// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
export const PDF_VERSION='2026-10-23-browser-artifacts-v8-flate';
export function pdfLayoutKey(options,ownerName) {
  return JSON.stringify([PDF_VERSION,options.style,options.locale,options.timezone,ownerName]);
}
