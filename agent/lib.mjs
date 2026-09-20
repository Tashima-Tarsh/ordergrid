import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { isIP } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const RETAILER_HOSTS = [
  "amazon.in",
  "flipkart.com",
  "myntra.com",
  "ajio.com",
  "tatacliq.com",
  "meesho.com",
  "nykaa.com",
  "jiomart.com"
];

const hostMatches=(host,root)=>host===root||host.endsWith(`.${root}`);

function publicStoreHost(host){
  if(!host||host==="localhost"||host.endsWith(".localhost")||host.endsWith(".local"))return false;
  if(isIP(host))return false;
  return host.includes(".");
}

export function allowedRetailerUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || value.length>2048) return false;
    const rawHost=url.hostname.toLowerCase();
    const host=rawHost.endsWith(".")?rawHost.slice(0,-1):rawHost;
    if(RETAILER_HOSTS.some(root=>hostMatches(host,root)))return true;
    const brandLookalike=RETAILER_HOSTS.some(root=>host.includes(root)&&!hostMatches(host,root));
    if(brandLookalike)return false;
    return publicStoreHost(host);
  } catch {
    return false;
  }
}

export function profileKey(reference) {
  return createHash("sha256").update(String(reference)).digest("hex").slice(0, 32);
}

export function profileRoot() {
  if (process.platform === "win32") {
    return join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "OrderGrid", "profiles");
  }
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "OrderGrid", "profiles");
  return join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "ordergrid", "profiles");
}

export function chromeCandidates() {
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA || "";
    return [
      join(process.env.PROGRAMFILES || "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
      join(process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
      join(local, "Google", "Chrome", "Application", "chrome.exe")
    ];
  }
  if (process.platform === "darwin") return ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"];
  return ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "google-chrome", "chromium", "chromium-browser"];
}

export function findChrome() {
  for (const candidate of chromeCandidates()) {
    if (candidate.includes("/") || candidate.includes("\\")) {
      if (existsSync(candidate)) return candidate;
    } else if (spawnSync(candidate, ["--version"], { stdio: "ignore" }).status === 0) {
      return candidate;
    }
  }
  return null;
}
