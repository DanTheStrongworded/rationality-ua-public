#!/usr/bin/env node
/**
 * Collects line-level git changes since a date into JSON.
 * Skips files that are purely added (new) or purely deleted — only mixed edits remain.
 *
 * Usage:
 *   node collect-changes.mjs [--since=2026-01-01] [--repo=..] [--out=changes.json] [--serve]
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function execGit(cwd, cmd) {
  return execSync(cmd, {
    cwd,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, GIT_PAGER: "cat", LC_ALL: "C" },
  }).trimEnd();
}

function parseArgs(argv) {
  let since = "2026-01-01T00:00:00Z";
  let repo = path.resolve(__dirname, "../..");
  let out = path.join(__dirname, "changes.json");
  let folder = "";
  let serve = false;
  let port = 3847;
  for (const a of argv) {
    if (a === "--serve") serve = true;
    else if (a.startsWith("--since=")) since = a.slice("--since=".length);
    else if (a.startsWith("--repo=")) repo = path.resolve(a.slice("--repo=".length));
    else if (a.startsWith("--out=")) out = path.resolve(a.slice("--out=".length));
    else if (a.startsWith("--folder=")) folder = a.slice("--folder=".length).trim();
    else if (a.startsWith("--port=")) port = Number(a.slice("--port=".length), 10);
    else if (a === "-h" || a === "--help") {
      console.log(`Usage: node collect-changes.mjs [options]

  --since=ISO|YYYY-MM-DD   Start of comparison window (default: 2026-01-01T00:00:00Z)
  --repo=PATH              Git repo root (default: rationality-ua root)
  --out=FILE               JSON output path (default: ./changes.json)
  --folder=REL_PATH        Limit to repo subfolder, e.g. books/1. Мапа і Територія
  --serve                  After writing JSON, serve this folder over HTTP
  --port=N                 Port for --serve (default: 3847)
`);
      process.exit(0);
    }
  }
  return { since, repo, out, folder, serve, port };
}

function resolveOldRev(repo, since) {
  let oldRev = "";
  try {
    oldRev = execGit(
      repo,
      `git rev-list -1 --before="${since.replace(/"/g, "")}" HEAD`,
    );
  } catch {
    oldRev = "";
  }
  if (!oldRev) {
    try {
      oldRev = execGit(repo, "git rev-list --max-parents=0 HEAD");
      console.warn(
        "[collect-changes] No commit strictly before --since; using first commit tree as baseline.",
      );
    } catch {
      console.error("[collect-changes] Not a git repository or no commits.");
      process.exit(1);
    }
  }
  return oldRev;
}

function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/** Decode a C-quoted path segment as emitted by git when core.quotePath is true. */
function decodeGitQuotedPath(quoted) {
  let s = quoted.trim();
  if (!s.startsWith('"') || !s.endsWith('"')) return quoted;
  s = s.slice(1, -1);
  const bytes = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== "\\") {
      bytes.push(s.charCodeAt(i));
      continue;
    }
    i++;
    if (i >= s.length) break;
    const n = s[i];
    if (n === "\\") {
      bytes.push(0x5c);
      continue;
    }
    if (n === '"') {
      bytes.push(0x22);
      continue;
    }
    let oct = n;
    let k = i + 1;
    while (k < s.length && oct.length < 3 && s[k] >= "0" && s[k] <= "7") {
      oct += s[k];
      k++;
    }
    if (/^[0-7]+$/.test(oct)) {
      bytes.push(parseInt(oct, 8));
      i = k - 1;
    } else {
      bytes.push(0x5c);
      i--;
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

/** Second path from a `diff --git` line (`b/` side), UTF-8, repo-relative. */
function pathFromDiffGitLine(line) {
  const prefix = "diff --git ";
  if (!line.startsWith(prefix)) return "";
  const rest = line.slice(prefix.length).replace(/\s+$/, "");
  const q = /^("(?:\\.|[^"\\])*")\s+("(?:\\.|[^"\\])*")$/.exec(rest);
  if (q) {
    const b = decodeGitQuotedPath(q[2]);
    return b.replace(/^b\//, "");
  }
  if (!rest.startsWith("a/")) return rest.replace(/^b\//, "");
  const mSep = /\s+b\//.exec(rest);
  if (mSep && mSep.index >= 2) {
    return rest.slice(mSep.index + mSep[0].length);
  }
  const m = /^a\/(.+?) b\/(.+)$/.exec(rest);
  return m ? m[2] : rest.replace(/^b\//, "");
}

/**
 * @param {string} diffText
 * @returns {{ path: string, pairs: { removed: string, added: string }[] }[]}
 */
function parseDiff(diffText) {
  const rawFiles = [];
  const lines = diffText.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.startsWith("diff --git ")) {
      i++;
      continue;
    }
    const displayPath = pathFromDiffGitLine(line);
    const file = { path: displayPath, hunks: [] };
    i++;
    while (i < lines.length && !lines[i].startsWith("diff --git ")) {
      const L = lines[i];
      if (L.startsWith("Binary files ") && L.endsWith(" differ")) {
        file.binary = true;
        i++;
        continue;
      }
      if (L.startsWith("@@ ")) {
        const hunkLines = [];
        i++;
        while (
          i < lines.length &&
          !lines[i].startsWith("@@ ") &&
          !lines[i].startsWith("diff --git ")
        ) {
          const hl = lines[i];
          if (hl === "\\ No newline at end of file") {
            i++;
            continue;
          }
          if (hl.startsWith("--- ") || hl.startsWith("+++ ")) {
            i++;
            continue;
          }
          if (hl.startsWith("-") && !hl.startsWith("---")) {
            hunkLines.push({ type: "del", text: hl.slice(1) });
          } else if (hl.startsWith("+") && !hl.startsWith("+++")) {
            hunkLines.push({ type: "add", text: hl.slice(1) });
          } else if (hl.startsWith(" ") || hl === "") {
            hunkLines.push({ type: "ctx", text: hl.startsWith(" ") ? hl.slice(1) : "" });
          }
          i++;
        }
        file.hunks.push(hunkLines);
        continue;
      }
      i++;
    }
    rawFiles.push(file);
  }

  const results = [];
  for (const f of rawFiles) {
    if (f.binary) continue;
    let delCount = 0;
    let addCount = 0;
    const pairs = [];
    for (const hunk of f.hunks) {
      const dels = [];
      const adds = [];
      for (const row of hunk) {
        if (row.type === "del") {
          dels.push(row.text);
          delCount++;
        } else if (row.type === "add") {
          adds.push(row.text);
          addCount++;
        }
      }
      const n = Math.max(dels.length, adds.length);
      for (let k = 0; k < n; k++) {
        pairs.push({
          removed: dels[k] ?? "",
          added: adds[k] ?? "",
        });
      }
    }
    if (delCount === 0 || addCount === 0) continue;
    results.push({ path: f.path, pairs });
  }
  return results;
}

function flattenChanges(files) {
  const slides = [];
  let lineChangeCount = 0;
  for (const f of files) {
    for (const p of f.pairs) {
      const hasR = p.removed !== "";
      const hasA = p.added !== "";
      if (!hasR && !hasA) continue;
      if (hasR) lineChangeCount += 1;
      if (hasA) lineChangeCount += 1;
      slides.push({
        path: f.path,
        fileName: path.basename(f.path),
        removed: p.removed,
        added: p.added,
      });
    }
  }
  return { slides, lineChangeCount };
}

function main() {
  const { since, repo, out, folder, serve, port } = parseArgs(process.argv.slice(2));

  let diffText;
  try {
    const oldRev = resolveOldRev(repo, since);
    const normalizedFolder = folder.replace(/^\.\/+/, "");
    const pathSpec = normalizedFolder ? ` -- ${shQuote(normalizedFolder)}` : "";
    diffText = execGit(
      repo,
      `git -c core.quotePath=false diff --no-color --unified=3 ${oldRev} HEAD${pathSpec}`,
    );
  } catch (e) {
    console.error("[collect-changes] git diff failed:", e.message);
    process.exit(1);
  }

  const files = parseDiff(diffText);
  const { slides, lineChangeCount } = flattenChanges(files);

  const payload = {
    generatedAt: new Date().toISOString(),
    since,
    repo: path.resolve(repo),
    folder: folder || null,
    lineChangeCount,
    slideCount: slides.length,
    slides,
  };

  fs.writeFileSync(out, JSON.stringify(payload, null, 2), "utf8");
  console.log(
    `[collect-changes] Wrote ${out} — ${slides.length} slide(s), ${lineChangeCount} line insertions/deletions counted (± pairs).`,
  );

  if (serve) {
    const dir = __dirname;
    const server = http.createServer((req, res) => {
      let urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
      if (urlPath === "/") urlPath = "/index.html";
      const safe = path.normalize(urlPath).replace(/^(\.\.(\/|\\|$))+/, "");
      const filePath = path.join(dir, safe);
      if (!filePath.startsWith(dir)) {
        res.writeHead(403);
        res.end();
        return;
      }
      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(404);
          res.end("Not found");
          return;
        }
        const ext = path.extname(filePath);
        const types = {
          ".html": "text/html; charset=utf-8",
          ".json": "application/json; charset=utf-8",
          ".js": "text/javascript; charset=utf-8",
        };
        res.writeHead(200, { "Content-Type": types[ext] || "application/octet-stream" });
        res.end(data);
      });
    });
    server.listen(port, () => {
      console.log(`[collect-changes] Open http://127.0.0.1:${port}/index.html`);
    });
  }
}

main();
