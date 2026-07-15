import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startPreviewServer } from "./preview";

async function writeRepository(root: string) {
  const screen = join(root, "design", "screens", "SCR-001-login");
  await mkdir(screen, { recursive: true });
  await writeFile(join(root, "structvibe.json"), JSON.stringify({
    schemaVersion: 1,
    projectId: "260e1331-b0a6-47ca-85b7-d53d8d16e95d",
    projectSlug: "luyende",
    name: "LuyenDe",
    defaultBranch: "main"
  }));
  await writeFile(join(root, "overview.md"), "# LuyenDe\n");
  await writeFile(join(root, "design", "tokens.css"), ":root { --color-primary: #13241d; }");
  await writeFile(join(screen, "screen.json"), JSON.stringify({
    schemaVersion: 1,
    id: "4f692497-6411-4f5b-bdd5-c7281aebd339",
    code: "SCR-001-login",
    name: "Login",
    status: "draft",
    viewport: { width: 390, height: 844 }
  }));
  await writeFile(join(screen, "screen.html"), `<!doctype html><html><head>
    <link rel="stylesheet" href="../../tokens.css"><link rel="stylesheet" href="./screen.css">
    </head><body><main>Login</main></body></html>`);
  await writeFile(join(screen, "screen.css"), "body { margin: 0; }");
}

test("preview serves a local shell and sandboxed screen source", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "structvibe-preview-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeRepository(root);
  const preview = await startPreviewServer({ root, projectName: "LuyenDe", branch: "main", port: 0 });
  context.after(() => preview.close());

  const shell = await fetch(preview.url);
  assert.equal(shell.status, 200);
  assert.match(await shell.text(), /LuyenDe/u);
  assert.match(shell.headers.get("content-security-policy") ?? "", /nonce-/u);

  const screen = await fetch(`${preview.url.replace(/\?.*$/u, "")}repo/design/screens/SCR-001-login/screen.html`);
  assert.equal(screen.status, 200);
  assert.match(await screen.text(), /<main>Login<\/main>/u);
  assert.match(screen.headers.get("content-security-policy") ?? "", /script-src 'none'/u);

  const css = await fetch(`${preview.url.replace(/\?.*$/u, "")}repo/design/screens/SCR-001-login/screen.css`);
  assert.equal(await css.text(), "body { margin: 0; }");
});

test("preview never serves paths outside the repository profile", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "structvibe-preview-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeRepository(root);
  await writeFile(join(root, "secret.txt"), "private");
  const preview = await startPreviewServer({ root, projectName: "LuyenDe", branch: "main", port: 0 });
  context.after(() => preview.close());

  const response = await fetch(`${preview.url.replace(/\?.*$/u, "")}repo/%2e%2e/secret.txt`);
  assert.equal(response.status, 404);
});

test("preview resolves immutable repository assets without exposing credentials", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "structvibe-preview-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeRepository(root);
  const bytes = new TextEncoder().encode("safe image bytes");
  const hash = createHash("sha256").update(bytes).digest("hex");
  const screenRoot = join(root, "design", "screens", "SCR-001-login");
  await writeFile(
    join(screenRoot, "screen.html"),
    `<html><head><link rel="stylesheet" href="./screen.css"></head><body><img src="asset://${hash}" alt="Hero"></body></html>`
  );
  await writeFile(
    join(screenRoot, "screen.css"),
    `.hero { background-image: url("asset://${hash}"); }`
  );
  let requests = 0;
  const preview = await startPreviewServer({
    root,
    projectName: "LuyenDe",
    branch: "main",
    port: 0,
    resolveAsset: async (contentHash) => {
      requests += 1;
      assert.equal(contentHash, hash);
      return { bytes, contentType: "image/png" };
    }
  });
  context.after(() => preview.close());
  const origin = preview.url.replace(/\?.*$/u, "");

  const html = await fetch(`${origin}repo/design/screens/SCR-001-login/screen.html`).then((response) => response.text());
  const css = await fetch(`${origin}repo/design/screens/SCR-001-login/screen.css`).then((response) => response.text());
  assert.match(html, new RegExp(`/__sv/assets/${hash}`, "u"));
  assert.match(css, new RegExp(`/__sv/assets/${hash}`, "u"));
  assert.doesNotMatch(`${html}${css}`, /asset:\/\//u);

  const asset = await fetch(`${origin}__sv/assets/${hash}`);
  assert.equal(asset.headers.get("content-type"), "image/png");
  assert.deepEqual(new Uint8Array(await asset.arrayBuffer()), bytes);
  assert.equal(requests, 1);
});

test("preview explains when a branch screen is actually empty", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "structvibe-preview-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeRepository(root);
  await writeFile(
    join(root, "design", "screens", "SCR-001-login", "screen.html"),
    `<html><body><main data-sv-id="screen-root"></main></body></html>`
  );
  const preview = await startPreviewServer({
    root,
    projectName: "LuyenDe",
    branch: "main",
    port: 0
  });
  context.after(() => preview.close());

  const shell = await fetch(preview.url).then((response) => response.text());
  assert.match(shell, /source warning/u);
  assert.match(shell, /branch source is blank/u);
});
