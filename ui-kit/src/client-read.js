// ui-kit/src/client-read.ts
import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
var WIN_DRIVE_RE = /^[A-Za-z]:/;
function isSafeClientPath(path) {
  if (typeof path !== "string" || path.length === 0) return false;
  if (path.includes("\\") || path.includes("\0")) return false;
  if (path.startsWith("/") || WIN_DRIVE_RE.test(path)) return false;
  if (!path.endsWith(".js")) return false;
  return path.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}
function clientRelPath(path) {
  if (path.startsWith("execute/web/")) return path.slice("execute/web/".length);
  if (path.startsWith("web/")) return path.slice("web/".length);
  return path;
}
function resolveClientPath(webDir, path) {
  if (!isSafeClientPath(path)) return null;
  const base = resolve(webDir);
  const full = resolve(base, path);
  if (full !== base && !full.startsWith(base + sep)) return null;
  return full;
}
function readClientFileText(webDir, path) {
  const full = resolveClientPath(webDir, path);
  if (full === null) return null;
  try {
    return readFileSync(full, "utf8");
  } catch {
    return null;
  }
}
function readClientFileInfo(webDir, path) {
  const full = resolveClientPath(webDir, path);
  if (full === null) return null;
  try {
    return { path, text: readFileSync(full, "utf8") };
  } catch {
    return null;
  }
}
function readClientFileResult(baseDir, path) {
  if (!isSafeClientPath(path)) return { ok: false, code: "bad_path" };
  const root = resolve(baseDir);
  const target = resolve(root, ...clientRelPath(path).split("/"));
  if (target !== root && !target.startsWith(root + sep)) return { ok: false, code: "bad_path" };
  try {
    return { ok: true, path, text: readFileSync(target, "utf8") };
  } catch {
    return { ok: false, code: "not_found" };
  }
}
export {
  clientRelPath,
  isSafeClientPath,
  readClientFileInfo,
  readClientFileResult,
  readClientFileText,
  resolveClientPath
};
