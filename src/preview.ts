import { randomBytes } from "node:crypto";
import { watch, type Dirent, type FSWatcher } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { relative, resolve, sep } from "node:path";
import {
  isRepositoryPathAllowed,
  repositoryMediaType,
  screenManifestSchema,
  validateRepositoryFiles,
  type RepositoryValidationResult
} from "./repository/index";
import { readWorkingFiles } from "./files";

export interface PreviewScreen {
  code: string;
  name: string;
  viewport: { width: number; height: number };
}

export interface PreviewServerOptions {
  root: string;
  projectName: string;
  branch: string;
  screen?: string | undefined;
  host?: string | undefined;
  port?: number | undefined;
  resolveAsset?: ((contentHash: string) => Promise<PreviewAsset | null>) | undefined;
}

export interface PreviewAsset {
  bytes: Uint8Array;
  contentType: string;
}

export interface RunningPreviewServer {
  url: string;
  host: string;
  port: number;
  close: () => Promise<void>;
}

const screenDirectoryPattern = /^SCR-[A-Za-z0-9_-]+$/u;
const assetHashPattern = /^[a-f0-9]{64}$/u;
const assetReferencePattern = /asset:\/\/([a-f0-9]{64})/gu;

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function scriptJson(value: unknown) {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

export async function discoverPreviewScreens(root: string): Promise<PreviewScreen[]> {
  const directory = resolve(root, "design", "screens");
  let entries: Dirent<string>[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }

  const screens = await Promise.all(entries
    .filter((entry) => entry.isDirectory() && screenDirectoryPattern.test(entry.name))
    .map(async (entry) => {
      try {
        const manifest = screenManifestSchema.parse(JSON.parse(
          await readFile(resolve(directory, entry.name, "screen.json"), "utf8")
        ));
        return { code: entry.name, name: manifest.name, viewport: manifest.viewport };
      } catch {
        return { code: entry.name, name: entry.name, viewport: { width: 390, height: 844 } };
      }
    }));
  return screens.sort((left, right) => left.code.localeCompare(right.code));
}

async function validationResult(root: string): Promise<RepositoryValidationResult> {
  try {
    return validateRepositoryFiles(await readWorkingFiles(root));
  } catch (error) {
    return {
      ok: false,
      issues: [{ code: "WORKING_TREE_ERROR", message: error instanceof Error ? error.message : String(error) }],
      warnings: [],
      fileCount: 0,
      byteSize: 0
    };
  }
}

export function rewritePreviewAssetReferences(source: string) {
  return source.replace(assetReferencePattern, (_match, contentHash: string) =>
    `/__sv/assets/${contentHash}`
  );
}

function setCommonHeaders(response: ServerResponse) {
  response.setHeader("cache-control", "no-store, max-age=0");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("cross-origin-resource-policy", "same-origin");
}

function send(response: ServerResponse, status: number, contentType: string, body: string | Buffer) {
  response.statusCode = status;
  setCommonHeaders(response);
  response.setHeader("content-type", contentType);
  response.end(body);
}

function shellSource(input: {
  projectName: string;
  branch: string;
  screens: PreviewScreen[];
  selected: string;
  validation: Awaited<ReturnType<typeof validationResult>>;
  nonce: string;
}) {
  const selected = input.screens.find((screen) => screen.code === input.selected) ?? input.screens[0];
  if (!selected) throw new Error("The repository has no screens to preview.");
  const screenData = scriptJson(input.screens);
  const validationCount = input.validation.issues.length;
  const warningByScreen = Object.fromEntries(
    input.screens.flatMap((screen) => {
      const root = `design/screens/${screen.code}/`;
      const warning = input.validation.warnings.find((item) => item.path?.startsWith(root));
      return warning ? [[screen.code, warning.message]] : [];
    })
  );
  const warningData = scriptJson(warningByScreen);
  const warningCount = input.validation.warnings.length;
  const statusState = input.validation.ok
    ? warningCount > 0 ? "warning" : "valid"
    : "error";
  const statusLabel = input.validation.ok
    ? warningCount > 0
      ? `${warningCount} source warning${warningCount === 1 ? "" : "s"}`
      : "Valid"
    : `${validationCount} issue${validationCount === 1 ? "" : "s"}`;
  const screenLinks = input.screens.map((screen) => `
        <button class="screen-item${screen.code === selected.code ? " active" : ""}${warningByScreen[screen.code] ? " warning" : ""}" data-screen="${escapeHtml(screen.code)}" type="button">
          <span>${escapeHtml(screen.name)}</span><small>${escapeHtml(screen.code)}</small>
        </button>`).join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(input.projectName)} · StructVibe preview</title>
  <style nonce="${input.nonce}">
    :root { color: #14211c; background: #eef2f0; font: 14px/1.4 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
    html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; }
    button { color: inherit; font: inherit; }
    .app { display: grid; grid-template-rows: 52px minmax(0, 1fr); width: 100%; height: 100%; }
    .topbar { display: grid; grid-template-columns: minmax(220px, 1fr) auto minmax(220px, 1fr); align-items: center; gap: 16px; padding: 0 16px; border-bottom: 1px solid #ccd7d1; background: #fbfcfb; }
    .identity { display: flex; min-width: 0; align-items: center; gap: 10px; }
    .mark { display: grid; width: 28px; height: 28px; place-items: center; border-radius: 5px; background: #10241b; color: #fff; font-size: 11px; font-weight: 800; }
    .identity strong, .identity small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .identity small { color: #63726a; font-size: 11px; }
    .viewport { color: #53635b; font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; }
    .tools { display: flex; justify-content: flex-end; align-items: center; gap: 8px; }
    .status { display: inline-flex; align-items: center; gap: 7px; padding: 6px 9px; border: 1px solid #cbd7d0; border-radius: 999px; background: #fff; color: #426051; font-size: 12px; font-weight: 700; }
    .status::before { width: 7px; height: 7px; border-radius: 50%; background: #4d946d; content: ""; }
    .status[data-state="warning"]::before { background: #c58d35; }
    .status[data-state="error"]::before { background: #c8755f; }
    .zoom { display: flex; overflow: hidden; border: 1px solid #cbd7d0; border-radius: 6px; background: #fff; }
    .zoom button { min-width: 46px; height: 30px; border: 0; border-left: 1px solid #d7e0db; background: transparent; cursor: pointer; }
    .zoom button:first-child { border-left: 0; }
    .zoom button.active { background: #10241b; color: #fff; }
    .workspace { display: grid; grid-template-columns: 228px minmax(0, 1fr); min-height: 0; }
    .sidebar { overflow: auto; border-right: 1px solid #ccd7d1; background: #f8faf9; }
    .sidebar-head { position: sticky; top: 0; z-index: 1; padding: 14px 14px 10px; background: #f8faf9; color: #66756d; font-size: 10px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }
    .screen-list { display: grid; gap: 3px; padding: 0 8px 12px; }
    .screen-item { width: 100%; padding: 9px 10px; border: 1px solid transparent; border-radius: 5px; background: transparent; text-align: left; cursor: pointer; }
    .screen-item:hover { background: #edf3ef; }
    .screen-item.active { border-color: #a9c4b5; background: #fff; box-shadow: 0 1px 2px rgb(16 36 27 / 7%); }
    .screen-item.warning { position: relative; padding-right: 28px; }
    .screen-item.warning::after { position: absolute; top: 13px; right: 10px; width: 7px; height: 7px; border-radius: 50%; background: #c58d35; content: ""; }
    .screen-item span, .screen-item small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .screen-item span { font-weight: 750; }
    .screen-item small { margin-top: 2px; color: #738078; font: 10px ui-monospace, SFMono-Regular, Menlo, monospace; }
    .canvas { position: relative; min-width: 0; min-height: 0; overflow: auto; background-color: #e9eeeb; background-image: radial-gradient(#c8d2cd 0.7px, transparent 0.7px); background-size: 16px 16px; }
    .stage { display: grid; min-width: 100%; min-height: 100%; place-items: center; padding: 44px; }
    .scaled-frame { position: relative; flex: none; }
    iframe { position: absolute; inset: 0 auto auto 0; display: block; border: 1px solid #afbeb6; border-radius: 2px; background: #fff; box-shadow: 0 18px 48px rgb(25 45 36 / 14%); transform-origin: top left; }
    .error-note { position: absolute; right: 14px; bottom: 14px; max-width: min(480px, calc(100% - 28px)); padding: 10px 12px; border: 1px solid #deb2a7; border-radius: 6px; background: #fff8f6; color: #7d3e31; font-size: 12px; }
    .error-note[data-tone="warning"] { border-color: #dec89e; background: #fffaf0; color: #674b1e; }
    .error-note[hidden] { display: none; }
    @media (max-width: 760px) {
      .topbar { grid-template-columns: minmax(0, 1fr) auto; }
      .viewport { display: none; }
      .workspace { grid-template-columns: 1fr; }
      .sidebar { display: none; }
      .stage { padding: 24px; }
    }
  </style>
</head>
<body>
  <div class="app">
    <header class="topbar">
      <div class="identity"><span class="mark">SV</span><span><strong>${escapeHtml(input.projectName)}</strong><small>${escapeHtml(input.branch)} · local preview</small></span></div>
      <span class="viewport" id="viewport">${selected.viewport.width} × ${selected.viewport.height}</span>
      <div class="tools">
        <span class="status" data-state="${statusState}">${statusLabel}</span>
        <div class="zoom"><button class="active" data-zoom="fit" type="button">Fit</button><button data-zoom="1" type="button">100%</button></div>
      </div>
    </header>
    <div class="workspace">
      <aside class="sidebar"><div class="sidebar-head">Screens · ${input.screens.length}</div><div class="screen-list">${screenLinks}
      </div></aside>
      <main class="canvas" id="canvas"><div class="stage" id="stage"><div class="scaled-frame" id="scaled-frame"><iframe id="preview" sandbox="allow-same-origin" title="Screen preview"></iframe></div></div>
        <div class="error-note" data-tone="${input.validation.ok ? "warning" : "error"}" id="source-note"${input.validation.ok && !warningByScreen[selected.code] ? " hidden" : ""}></div>
      </main>
    </div>
  </div>
  <script nonce="${input.nonce}">
    const screens = ${screenData};
    const screenWarnings = ${warningData};
    const frame = document.getElementById("preview");
    const scaledFrame = document.getElementById("scaled-frame");
    const canvas = document.getElementById("canvas");
    const viewport = document.getElementById("viewport");
    const sourceNote = document.getElementById("source-note");
    let current = ${scriptJson(selected.code)};
    let zoom = "fit";

    function selectedScreen() { return screens.find((screen) => screen.code === current) || screens[0]; }
    function updateSourceNote() {
      if (!sourceNote) return;
      const warning = screenWarnings[current];
      if (warning) {
        sourceNote.hidden = false;
        sourceNote.dataset.tone = "warning";
        sourceNote.textContent = warning + " The preview is rendering this branch's HTML and CSS exactly.";
        return;
      }
      if (${scriptJson(!input.validation.ok)}) {
        sourceNote.hidden = false;
        sourceNote.dataset.tone = "error";
        sourceNote.innerHTML = "Run <strong>sv check</strong> for validation details. Preview remains sandboxed while you edit.";
        return;
      }
      sourceNote.hidden = true;
      sourceNote.textContent = "";
    }
    function applyScale() {
      const screen = selectedScreen();
      if (!screen) return;
      const availableWidth = Math.max(160, canvas.clientWidth - 88);
      const availableHeight = Math.max(160, canvas.clientHeight - 88);
      const scale = zoom === "fit" ? Math.min(1, availableWidth / screen.viewport.width, availableHeight / screen.viewport.height) : 1;
      frame.style.width = screen.viewport.width + "px";
      frame.style.height = screen.viewport.height + "px";
      frame.style.transform = "scale(" + scale + ")";
      scaledFrame.style.width = Math.round(screen.viewport.width * scale) + "px";
      scaledFrame.style.height = Math.round(screen.viewport.height * scale) + "px";
      viewport.textContent = screen.viewport.width + " × " + screen.viewport.height + (scale < 1 ? " · " + Math.round(scale * 100) + "%" : "");
    }
    function loadScreen(code, replaceHistory = false) {
      const screen = screens.find((item) => item.code === code);
      if (!screen) return;
      current = screen.code;
      document.querySelectorAll("[data-screen]").forEach((item) => item.classList.toggle("active", item.dataset.screen === current));
      const url = new URL(location.href);
      url.searchParams.set("screen", current);
      history[replaceHistory ? "replaceState" : "pushState"]({}, "", url);
      frame.src = "/repo/design/screens/" + encodeURIComponent(current) + "/screen.html?v=" + Date.now();
      applyScale();
      updateSourceNote();
    }
    frame.addEventListener("load", () => {
      try {
        frame.contentDocument.addEventListener("click", (event) => {
          const anchor = event.target.closest?.('a[href^="#SCR-"]');
          if (!anchor) return;
          event.preventDefault();
          loadScreen(anchor.getAttribute("href").slice(1));
        });
      } catch {}
    });
    document.querySelectorAll("[data-screen]").forEach((button) => button.addEventListener("click", () => loadScreen(button.dataset.screen)));
    document.querySelectorAll("[data-zoom]").forEach((button) => button.addEventListener("click", () => {
      zoom = button.dataset.zoom;
      document.querySelectorAll("[data-zoom]").forEach((item) => item.classList.toggle("active", item === button));
      applyScale();
    }));
    addEventListener("resize", applyScale);
    addEventListener("popstate", () => loadScreen(new URL(location.href).searchParams.get("screen") || current, true));
    const events = new EventSource("/__sv/events");
    events.addEventListener("reload", () => location.reload());
    loadScreen(current, true);
  </script>
</body>
</html>`;
}

function repositoryPath(root: string, pathname: string) {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname.slice("/repo/".length));
  } catch {
    return null;
  }
  if (!isRepositoryPathAllowed(decoded)) return null;
  const absolute = resolve(root, decoded);
  const fromRoot = relative(root, absolute);
  if (!fromRoot || fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) return null;
  return { path: decoded, absolute };
}

function listen(server: Server, host: string, port: number) {
  return new Promise<void>((resolvePromise, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolvePromise();
    });
  });
}

export async function startPreviewServer(options: PreviewServerOptions): Promise<RunningPreviewServer> {
  const host = options.host ?? "127.0.0.1";
  const requestedPort = options.port ?? 4173;
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65_535) {
    throw new Error("Preview port must be between 0 and 65535.");
  }
  const root = resolve(options.root);
  const initialScreens = await discoverPreviewScreens(root);
  if (initialScreens.length === 0) throw new Error("No design screens were found in this checkout.");
  if (options.screen && !initialScreens.some((screen) => screen.code === options.screen)) {
    throw new Error(`Screen '${options.screen}' does not exist. Available screens: ${initialScreens.map((screen) => screen.code).join(", ")}`);
  }
  const defaultScreen = options.screen ?? initialScreens[0]?.code ?? "";
  const clients = new Set<ServerResponse>();
  const nonce = randomBytes(18).toString("base64url");

  const server = createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? `${host}:${requestedPort}`}`);
      if (requestUrl.pathname === "/__sv/events") {
        response.statusCode = 200;
        setCommonHeaders(response);
        response.setHeader("content-type", "text/event-stream");
        response.setHeader("connection", "keep-alive");
        response.flushHeaders();
        response.write(": ready\n\n");
        clients.add(response);
        request.on("close", () => clients.delete(response));
        return;
      }
      if (requestUrl.pathname === "/__sv/validation") {
        send(response, 200, "application/json; charset=utf-8", JSON.stringify(await validationResult(root)));
        return;
      }
      if (requestUrl.pathname.startsWith("/__sv/assets/")) {
        const contentHash = requestUrl.pathname.slice("/__sv/assets/".length);
        if (!assetHashPattern.test(contentHash) || !options.resolveAsset) {
          send(response, 404, "text/plain; charset=utf-8", "Asset not found");
          return;
        }
        const asset = await options.resolveAsset(contentHash);
        if (!asset) {
          send(response, 404, "text/plain; charset=utf-8", "Asset not found");
          return;
        }
        response.statusCode = 200;
        setCommonHeaders(response);
        response.setHeader("cache-control", "private, max-age=31536000, immutable");
        response.setHeader("content-type", asset.contentType);
        response.setHeader("content-length", String(asset.bytes.byteLength));
        response.end(Buffer.from(asset.bytes));
        return;
      }
      if (requestUrl.pathname.startsWith("/repo/")) {
        const target = repositoryPath(root, requestUrl.pathname);
        if (!target) {
          send(response, 404, "text/plain; charset=utf-8", "Not found");
          return;
        }
        let content: Buffer;
        try {
          content = await readFile(target.absolute);
        } catch {
          send(response, 404, "text/plain; charset=utf-8", "Not found");
          return;
        }
        setCommonHeaders(response);
        if (target.path.endsWith(".html")) {
          response.setHeader(
            "content-security-policy",
            "default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'"
          );
        }
        const mediaType = repositoryMediaType(target.path);
        const body = target.path.endsWith(".html") || target.path.endsWith(".css")
          ? Buffer.from(rewritePreviewAssetReferences(content.toString("utf8")), "utf8")
          : content;
        response.statusCode = 200;
        response.setHeader("content-type", `${mediaType}; charset=utf-8`);
        response.end(body);
        return;
      }
      if (requestUrl.pathname === "/favicon.ico") {
        response.statusCode = 204;
        response.end();
        return;
      }
      if (requestUrl.pathname !== "/") {
        send(response, 404, "text/plain; charset=utf-8", "Not found");
        return;
      }

      const screens = await discoverPreviewScreens(root);
      const requestedScreen = requestUrl.searchParams.get("screen");
      const selected = screens.some((screen) => screen.code === requestedScreen)
        ? requestedScreen ?? defaultScreen
        : screens.some((screen) => screen.code === defaultScreen) ? defaultScreen : screens[0]?.code ?? "";
      const validation = await validationResult(root);
      setCommonHeaders(response);
      response.setHeader(
        "content-security-policy",
        `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; frame-src 'self'; img-src data:; base-uri 'none'; form-action 'none'`
      );
      send(response, 200, "text/html; charset=utf-8", shellSource({
        projectName: options.projectName,
        branch: options.branch,
        screens,
        selected,
        validation,
        nonce
      }));
    } catch (error) {
      send(response, 500, "text/plain; charset=utf-8", error instanceof Error ? error.message : "Preview failed.");
    }
  });

  await listen(server, host, requestedPort);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Preview server did not expose a TCP address.");
  const browserHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host.includes(":") ? `[${host}]` : host;
  const url = `http://${browserHost}:${address.port}/?screen=${encodeURIComponent(defaultScreen)}`;

  let watcher: FSWatcher | null = null;
  let reloadTimer: NodeJS.Timeout | null = null;
  try {
    watcher = watch(root, { recursive: true }, (_event, filename) => {
      const path = String(filename ?? "").replaceAll("\\", "/");
      if (!path || path === ".structvibe" || path.startsWith(".structvibe/")) return;
      if (reloadTimer) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => {
        for (const client of clients) client.write("event: reload\ndata: {}\n\n");
      }, 100);
    });
  } catch {
    watcher = null;
  }
  const heartbeat = setInterval(() => {
    for (const client of clients) client.write(": heartbeat\n\n");
  }, 15_000);
  heartbeat.unref();

  return {
    url,
    host,
    port: address.port,
    close: async () => {
      if (reloadTimer) clearTimeout(reloadTimer);
      clearInterval(heartbeat);
      watcher?.close();
      for (const client of clients) client.end();
      clients.clear();
      await new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
    }
  };
}
