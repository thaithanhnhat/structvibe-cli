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
    { path: "design/screens/SCR-001-login/screen.html", content: screenHtml }
  ];
}

test("accepts deterministic HTML, CSS, inline SVG, and internal screen links", () => {
  const result = validateRepositoryFiles(repository(`<!doctype html>
    <html><head><style>.cta { color: var(--color-primary); }</style></head>
    <body><main data-sv-id="root"><a class="cta" href="#SCR-002">Continue</a>
    <svg viewBox="0 0 24 24"><path d="M2 12h20" /></svg></main></body></html>`));
  assert.equal(result.ok, true, JSON.stringify(result.issues));
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
