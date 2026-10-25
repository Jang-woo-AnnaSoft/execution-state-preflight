"use strict";

/**
 * Which code produced a results file.
 *
 * A run on 2026-10-25 came from a Codespace that had not pulled the day's changes. The results
 * file looked like any other; only the absence of fields added that day gave it away, and only
 * to someone who knew to look. A results file should say what made it.
 *
 * Two things, because either alone can mislead:
 *   git     the commit, and whether the working tree had uncommitted changes. null outside git
 *   files   a short hash of every file whose content decides what a run does — the skeleton, the
 *           example's code, and its declarations. These match across machines whatever git says,
 *           so two results files can be compared without trusting either checkout.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const HERE = __dirname;
const ROOT = path.join(HERE, "..");

function filesThatDecideARun() {
  const own = fs.readdirSync(HERE)
    .filter(f => (f.endsWith(".js") && !/(-test|selftest)\.js$/.test(f)) ||
                 f === "instructions.json" || f === "models.json")
    .map(f => path.join(HERE, f));
  return [path.join(ROOT, "execution-state-preflight.js"), ...own].sort();
}

function shortHash(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex").slice(0, 12);
}

function git(args) {
  try {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function codeVersion() {
  const commit = git(["rev-parse", "HEAD"]);
  const dirty = commit === null ? null : (git(["status", "--porcelain", "--untracked-files=no"]) ?? "") !== "";
  const files = Object.fromEntries(filesThatDecideARun().map(f => [path.relative(ROOT, f), shortHash(f)]));
  return { git: commit === null ? null : { commit, dirty }, files };
}

module.exports = { codeVersion };
