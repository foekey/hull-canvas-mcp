import { chromium, request } from "playwright-core";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const CANVAS = process.env.CANVAS_URL || "https://canvas.hull.ac.uk";
const PAN = process.env.PANOPTO_URL || "https://uoh.cloud.panopto.eu";
const LOCAL = process.env.LOCALAPPDATA || "";
// Any Chromium browser works for sign-in; Brave is preferred, then Chrome, then Edge.
const BRAVE = [
  process.env.BROWSER_PATH || process.env.BRAVE_PATH,
  "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
  join(LOCAL, "BraveSoftware\\Brave-Browser\\Application\\brave.exe"),
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/usr/bin/brave-browser", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/microsoft-edge",
].find((p) => p && existsSync(p));
// Dedicated profile: the everyday browser locks its profile while open, so we keep our own login here.
const PROFILE = process.env.HULL_PROFILE || join(homedir(), ".hull-mcp-profile");
const COOKIES = PROFILE + ".cookies.json";

// Normal calls are plain HTTP with saved cookies (no browser). Brave only starts to log in or refresh a lapsed session.
let api = null;
async function getApi() {
  if (api) return api;
  let cookies = [];
  try { cookies = JSON.parse(readFileSync(COOKIES, "utf8")); } catch { /* not logged in yet */ }
  const exp = Date.now() / 1000 + 14 * 864e3; // session cookies have no expiry; give them one
  api = await request.newContext({
    storageState: { cookies: cookies.map((k) => (k.expires > 0 ? k : { ...k, expires: exp })), origins: [] },
    extraHTTPHeaders: { Accept: "application/json" },
  });
  return api;
}
const resetApi = async () => { await api?.dispose(); api = null; };

function launch(headless) {
  if (!BRAVE) throw new Error("No Brave/Chrome/Edge found. Set BROWSER_PATH to its executable.");
  return chromium.launchPersistentContext(PROFILE, { executablePath: BRAVE, headless, viewport: { width: 1280, height: 900 } });
}

// Walks Canvas/Panopto sign-in; Hull SSO reuses the Microsoft cookies in the profile, so no typing is needed.
async function signInPanopto(c, ms) {
  const p = await c.newPage();
  try {
    await p.goto(PAN + "/Panopto/Pages/Home.aspx");
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const u = p.url();
      if (u.startsWith(PAN) && !/Login\.aspx/i.test(u)) return true;
      if (/Login\.aspx/i.test(u)) await p.getByText("Sign in", { exact: true }).first().click({ timeout: 1500 }).catch(() => {});
      else if (u.includes("login.microsoftonline.com"))
        await p.locator('[data-test-id*="hull.ac.uk" i]').first().click({ timeout: 1500 }).catch(() => {});
      await p.waitForTimeout(1500).catch(() => {});
    }
    return false;
  } finally { await p.close().catch(() => {}); }
}

async function canvasSignedIn(c) {
  const r = await c.request.get(CANVAS + "/api/v1/users/self", { headers: { Accept: "application/json" } });
  return r.ok() ? (await r.json()).name : null;
}

let reauthing = null; // one refresh at a time, shared by parallel calls
function reauth() {
  return (reauthing ??= (async () => {
    const c = await launch(true);
    try {
      const p = await c.newPage();
      await p.goto(CANVAS);
      const until = Date.now() + 60_000;
      while (Date.now() < until && !(p.url().startsWith(CANVAS) && (await canvasSignedIn(c)))) {
        if (p.url().includes("login.microsoftonline.com"))
          await p.locator('[data-test-id*="hull.ac.uk" i]').first().click({ timeout: 1500 }).catch(() => {});
        await p.waitForTimeout(1500).catch(() => {});
      }
      if (!(await canvasSignedIn(c))) throw new Error("Session expired and needs a password. Run the `login` tool.");
      await signInPanopto(c, 60_000);
      writeFileSync(COOKIES, JSON.stringify(await c.cookies()));
    } finally { await c.close().catch(() => {}); reauthing = null; await resetApi(); }
  })());
}

const cache = new Map(); // url -> {t, v}
// Canvas REST call; follows Link rel=next; cached for ttl ms; refreshes the session once if it lapsed.
export async function canvas(path, { ttl = 60_000, all = true } = {}) {
  let url = path.startsWith("http") ? path : CANVAS + "/api/v1" + path;
  const key = url + all;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttl) return hit.v;
  const out = [];
  let retried = false;
  for (let i = 0; url && i < 50; i++) {
    const r = await (await getApi()).get(url);
    if (r.status() === 401 || !(r.headers()["content-type"] || "").includes("json")) {
      if (retried) throw new Error("Not signed in. Run the `login` tool.");
      retried = true; await reauth(); i--; continue;
    }
    if (!r.ok()) throw new Error(`Canvas ${r.status()} for ${url.replace(CANVAS, "")}`);
    const body = await r.json();
    if (!Array.isArray(body)) { cache.set(key, { t: Date.now(), v: body }); return body; }
    out.push(...body);
    url = all ? /<([^>]+)>;\s*rel="next"/.exec(r.headers().link || "")?.[1] : null;
  }
  cache.set(key, { t: Date.now(), v: out });
  return out;
}

// Raw bytes for a Canvas file download URL.
export async function download(url) {
  const r = await (await getApi()).get(url, { headers: { Accept: "*/*" } });
  if (!r.ok()) throw new Error(`Download failed (${r.status()}).`);
  return r.body();
}

// Panopto call; kind: "json" | "form".
export async function panopto(path, data, kind = "json") {
  const send = async () => {
    const r = await (await getApi()).post(PAN + path, kind === "json" ? { data } : { form: data });
    return (r.headers()["content-type"] || "").includes("json") ? r.json() : null;
  };
  let out = await send();
  if (!out) { await reauth(); out = await send(); }
  if (!out) throw new Error("Panopto session expired. Run the `login` tool.");
  return out;
}

export async function login() {
  const c = await launch(false);
  try {
    const page = c.pages()[0] ?? (await c.newPage());
    await page.goto(CANVAS);
    const until = Date.now() + 5 * 60_000;
    while (Date.now() < until) {
      if (page.url().startsWith(CANVAS)) {
        const name = await canvasSignedIn(c);
        if (name) {
          const pan = await signInPanopto(c, 2 * 60_000);
          writeFileSync(COOKIES, JSON.stringify(await c.cookies()));
          await resetApi();
          return `Signed in to Canvas as ${name}. Panopto: ${pan ? "ok" : "NOT signed in, run login again"}.`;
        }
      }
      await page.waitForTimeout(1500).catch(() => {});
    }
    throw new Error("Timed out waiting for sign-in (5 min).");
  } finally { await c.close().catch(() => {}); }
}
