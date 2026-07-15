import assert from "node:assert/strict";
import test from "node:test";
import { validateRepositoryFiles, type RepositoryFile } from "./index";

function repository(screenHtml: string): RepositoryFile[] {
  return [
    {
      path: "structvibe.json",
      content: JSON.stringify({
        schemaVersion: 1,
        projectId: "260e1331-b0a6-47ca-85b7-d53d8d16e95d",
        projectSlug: "luyende",
        name: "LuyenDe",
        defaultBranch: "main"
      })
    },
    { path: "overview.md", content: "# LuyenDe\n\nPractice project." },
    { path: "design/tokens.css", content: ":root { --color-primary: #13241d; }" },
    {
      path: "design/screens/SCR-001-login/screen.json",
      content: JSON.stringify({
        schemaVersion: 1,
        id: "4f692497-6411-4f5b-bdd5-c7281aebd339",
        code: "SCR-001-login",
        name: "Login",
        status: "draft",
        viewport: { width: 390, height: 844 }
      })
    },
    { path: "design/screens/SCR-001-login/screen.html", content: screenHtml },
    { path: "design/screens/SCR-001-login/screen.css", content: ".cta { color: var(--color-primary); }" }
  ];
}

test("accepts deterministic HTML, CSS, inline SVG, and internal screen links", () => {
  const result = validateRepositoryFiles(repository(`<!doctype html>
    <html><head><link rel="stylesheet" href="../../tokens.css"><link rel="stylesheet" href="./screen.css"></head>
    <body><main data-sv-id="root"><a class="cta" href="#SCR-002">Continue</a>
    <svg viewBox="0 0 24 24"><path d="M2 12h20" /></svg></main></body></html>`));
  assert.equal(result.ok, true, JSON.stringify(result.issues));
});

test("blocks external or cross-screen stylesheets", () => {
  const result = validateRepositoryFiles(repository(`<!doctype html><html><head>
    <link rel="stylesheet" href="https://attacker.example/theme.css">
    </head><body><main>Login</main></body></html>`));
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((item) => item.code === "HTML_STYLESHEET_REFERENCE"));
  assert.ok(result.issues.some((item) => item.code === "HTML_EXTERNAL_REFERENCE"));
});

test("blocks scripts, event handlers, external URLs, and CSS imports", () => {
  const result = validateRepositoryFiles(repository(`<!doctype html><html><head>
    <style>@import url(https://attacker.example/x.css);</style></head><body>
    <script>alert(1)</script><a href="javascript:alert(1)" onclick="alert(1)">Open</a>
    </body></html>`));
  assert.equal(result.ok, false);
  const codes = new Set(result.issues.map((item) => item.code));
  assert.equal(codes.has("HTML_TAG_BLOCKED"), true);
  assert.equal(codes.has("HTML_EVENT_HANDLER"), true);
  assert.equal(codes.has("HTML_EXTERNAL_REFERENCE"), true);
  assert.equal(codes.has("CSS_AT_RULE_BLOCKED"), true);
});

test("rejects foreignObject and external SVG references", () => {
  const result = validateRepositoryFiles(repository(`<html><body><svg viewBox="0 0 10 10">
    <foreignObject><div>unsafe</div></foreignObject><use href="https://attacker.example/icon.svg#x" />
  </svg></body></html>`));
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((item) => item.code === "HTML_TAG_BLOCKED"));
  assert.ok(result.issues.some((item) => item.code === "HTML_EXTERNAL_REFERENCE"));
});

test("rejects invalid and duplicate stable element IDs", () => {
  const result = validateRepositoryFiles(repository(`<html><body>
    <main data-sv-id="same"><p data-sv-id="same">Duplicate</p></main>
    <p data-sv-id="not valid">Invalid</p>
  </body></html>`));
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((item) => item.code === "HTML_DUPLICATE_STABLE_ID"));
  assert.ok(result.issues.some((item) => item.code === "HTML_INVALID_STABLE_ID"));
});

test("accepts only SHA-256 content-addressed assets", () => {
  const hash = "a".repeat(64);
  const valid = validateRepositoryFiles(repository(
    `<html><body><main><img src="asset://${hash}" title="Preview"></main></body></html>`
  ));
  assert.equal(valid.ok, true, JSON.stringify(valid.issues));

  const invalid = validateRepositoryFiles(repository(
    `<html><body><main><img src="asset://${"a".repeat(32)}" title="Preview"></main></body></html>`
  ));
  assert.ok(invalid.issues.some((item) => item.code === "HTML_EXTERNAL_ASSET"));
});

test("warns without rejecting a screen whose branch source is empty", () => {
  const result = validateRepositoryFiles(repository(
    `<html><body><main data-sv-id="screen-root"></main></body></html>`
  ));
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.ok(result.warnings.some((item) => item.code === "SCREEN_SOURCE_EMPTY"));
});

test("identifies generated screen scaffolds as placeholders", () => {
  const result = validateRepositoryFiles(repository(
    `<html><body><main><p>SCR-001-login</p><h1>Login</h1></main></body></html>`
  ));
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.ok(result.warnings.some((item) => item.code === "SCREEN_SOURCE_PLACEHOLDER"));
});
