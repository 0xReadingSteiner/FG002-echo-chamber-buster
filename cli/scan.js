#!/usr/bin/env node
"use strict";
/*
  Echo Chamber Buster — batch scanner for archive datasets

  Purpose: dataset hygiene for researchers. Feed it the list of authors
  from a Reddit archive dump (e.g. a DataHoarder-style pull), get a
  scored JSONL back so bot-like accounts can be filtered out BEFORE the
  data goes into training.

  Usage:
    node cli/scan.js < usernames.txt > scan-results.jsonl
    node cli/scan.js usernames.txt > scan-results.jsonl
    node cli/scan.js --min 65 usernames.txt          # only >= 65

  Output (stdout): one JSONL record per username:
    { "username", "index", "band", "signals", "evidence", "dataQuality" }

  Summary goes to stderr. Exit code 0 even when a scan fails —
  per-account errors are embedded in the record.

  Requirements: Node >= 18, network access to the public archives
  (arctic-shift.photon-reddit.com, api.pullpush.io). Read-only: the
  scanner never posts or votes; it only reads public archive data.
*/
const fs = require("fs");
const path = require("path");

const DIR = path.join(__dirname, "..");

/* ---- minimal MV3 shims so the real background.js pipeline runs in node ---- */
global.chrome = {
  runtime: {
    getManifest: () => ({ name: "Echo Chamber Buster", version: "1.0.0" }),
    getURL: (p) => "file://" + path.join(DIR, p),
    onInstalled: { addListener: () => {} },
    onStartup: { addListener: () => {} },
    onMessage: { addListener: () => {} }
  }
};
global.importScripts = () => {};

// Load the signal engine as the DCS global that background.js expects
// (same wiring the extension's importScripts does in the browser).
const sigSrc = fs.readFileSync(path.join(DIR, "signals.js"), "utf8");
eval(
  sigSrc.replace(
    /if \(typeof module !== "undefined" && module\.exports\)[\s\S]*?else \{\s*globalThis\.DCS = Object\.freeze\(api\);\s*\}/,
    "globalThis.DCS = Object.freeze(api);"
  )
);

const src = fs.readFileSync(path.join(DIR, "background.js"), "utf8");
eval(src + "\n;globalThis.__internals = { deepScan, loadList };");

function usage() {
  console.error("usage: node cli/scan.js [--min N] [usernames.txt]");
  process.exit(2);
}

function parseArgs(argv) {
  let min = 0;
  let file = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--min") {
      min = Number(argv[++i]);
      if (!Number.isFinite(min)) usage();
    } else if (argv[i] === "--help" || argv[i] === "-h") {
      usage();
    } else if (!file) {
      file = argv[i];
    } else usage();
  }
  return { min, file };
}

(async () => {
  const { min, file } = parseArgs(process.argv.slice(2));
  await __internals.loadList();

  let names = [];
  if (file) {
    names = fs
      .readFileSync(file, "utf8")
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  } else {
    names = fs
      .readFileSync(0, "utf8")
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  // dedupe, keep order
  const seen = new Set();
  names = names.filter((n) => {
    const k = n.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const bands = { high: 0, elevated: 0, low: 0, unknown: 0, error: 0 };
  let started = 0;
  for (const name of names) {
    try {
      const rec = await __internals.deepScan(name, {}, true);
      started++;
      bands[rec.band] = (bands[rec.band] || 0) + 1;
      if (rec.index == null || rec.index >= min) {
        console.log(JSON.stringify(rec));
      }
    } catch (e) {
      started++;
      bands.error++;
      console.log(
        JSON.stringify({ username: name, error: String(e).slice(0, 200) })
      );
    }
  }

  console.error(
    `\n=== Echo Chamber Buster batch scan: ${started}/${names.length} accounts ===`
  );
  console.error(
    `HIGH=${bands.high} ELEVATED=${bands.elevated} LOW=${bands.low} UNKNOWN=${bands.unknown} ERRORS=${bands.error}`
  );
  console.error(
    "Dataset hygiene: filter records with band == 'high' before training; review 'elevated'."
  );
})().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
