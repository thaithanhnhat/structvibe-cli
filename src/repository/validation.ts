import { parse } from "parse5";
import * as csstree from "css-tree";
import {
  repositoryFileSchema,
  repositoryManifestSchema,
  screenManifestSchema,
  type RepositoryFile,
  type RepositoryValidationIssue,
  type RepositoryValidationResult
} from "./model";

const MAX_FILES = 2_000;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_HTML_NODES = 20_000;
const MAX_HTML_DEPTH = 64;
const MAX_CSS_NODES = 40_000;

const allowedHtmlTags = new Set([
  "a", "article", "aside", "body", "button", "dd", "div", "dl", "dt", "fieldset", "footer",
  "form", "h1", "h2", "h3", "h4", "h5", "h6", "head", "header", "hr", "html", "img", "input", "label",
  "legend", "li", "main", "meta", "nav", "ol", "option", "p", "section", "select", "small", "span",
  "strong", "style", "textarea", "title", "ul"
]);

const allowedSvgTags = new Set([
  "svg", "g", "path", "circle", "rect", "line", "polyline", "polygon", "ellipse", "text", "tspan",
  "defs", "lineargradient", "radialgradient", "stop", "clippath", "mask", "symbol", "use"
]);

const globalAttributes = new Set([
  "id", "class", "title", "role", "tabindex", "hidden", "lang", "dir", "style"
]);

const htmlAttributes = new Set([
  "charset", "name", "content", "type", "placeholder", "value", "autocomplete", "checked", "disabled",
  "readonly", "required", "multiple", "selected", "for", "rows", "cols", "min", "max", "step"
]);

const svgAttributes = new Set([
  "xmlns", "viewbox", "x", "y", "x1", "x2", "y1", "y2", "width", "height", "rx", "ry", "cx", "cy",
  "r", "d", "points", "fill", "fill-rule", "fill-opacity", "stroke", "stroke-width", "stroke-linecap",
  "stroke-linejoin", "stroke-opacity", "opacity", "transform", "preserveaspectratio", "gradientunits",
  "gradienttransform", "offset", "stop-color", "stop-opacity", "clip-path", "mask", "aria-hidden", "focusable"
]);

const allowedAtRules = new Set(["media", "container", "supports", "layer"]);
const blockedCssProperties = new Set([
  "animation", "animation-name", "animation-duration", "transition", "transition-property", "behavior",
  "-moz-binding"
]);

type HtmlNode = {
  nodeName: string;
  tagName?: string | undefined;
  value?: string | undefined;
  attrs?: Array<{ name: string; value: string; prefix?: string | undefined }> | undefined;
  childNodes?: HtmlNode[] | undefined;
  sourceCodeLocation?: { startLine?: number; startCol?: number } | undefined;
};

function issue(
  issues: RepositoryValidationIssue[],
  code: string,
  message: string,
  path?: string,
  node?: HtmlNode
) {
  issues.push({
    code,
    message,
    ...(path ? { path } : {}),
    ...(node?.sourceCodeLocation?.startLine ? { line: node.sourceCodeLocation.startLine } : {}),
    ...(node?.sourceCodeLocation?.startCol ? { column: node.sourceCodeLocation.startCol } : {})
  });
}

export function repositoryMediaType(path: string): string {
  if (path.endsWith(".html")) return "text/html";
  if (path.endsWith(".css")) return "text/css";
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".md")) return "text/markdown";
  return "text/plain";
}

export function isRepositoryPathAllowed(path: string): boolean {
  if (path === "structvibe.json" || path === "overview.md" || path === "design/tokens.css") return true;
  if (/^decisions\/DEC-[A-Za-z0-9_-]+\.md$/u.test(path)) return true;
  return /^design\/screens\/SCR-[A-Za-z0-9_-]+\/(screen\.(?:html|json)|features\/F-[A-Za-z0-9_-]+\.md)$/u.test(path);
}

function safeRepositoryPath(path: string): boolean {
  return !path.startsWith("/") && !path.includes("\\") && !path.includes("\0") && !path.split("/").includes("..");
}

function safeReference(value: string): boolean {
  return /^#[A-Za-z][A-Za-z0-9_-]*$/u.test(value) || /^#SCR-[A-Za-z0-9_-]+$/u.test(value);
}

function safeAssetReference(value: string): boolean {
  return /^asset:\/\/[a-f0-9]{32,128}$/u.test(value);
}

function validateCss(css: string, path: string, issues: RepositoryValidationIssue[], context: "stylesheet" | "declarationList" = "stylesheet") {
  if (Buffer.byteLength(css, "utf8") > 500_000) {
    issue(issues, "CSS_TOO_LARGE", "A CSS block may not exceed 500 KB.", path);
    return;
  }

  try {
    const ast = csstree.parse(css, { context, positions: true });
    let nodes = 0;
    csstree.walk(ast, (node) => {
      nodes += 1;
      if (nodes > MAX_CSS_NODES) throw new Error("CSS_COMPLEXITY_LIMIT");

      if (node.type === "Atrule" && !allowedAtRules.has(node.name.toLowerCase())) {
        issue(issues, "CSS_AT_RULE_BLOCKED", `@${node.name} is not supported by the StructVibe profile.`, path);
      }

      if (node.type === "Declaration" && blockedCssProperties.has(node.property.toLowerCase())) {
        issue(issues, "CSS_PROPERTY_BLOCKED", `${node.property} is nondeterministic or unsafe.`, path);
      }

      if (node.type === "Url" && !safeReference(node.value) && !safeAssetReference(node.value)) {
        issue(issues, "CSS_EXTERNAL_URL", `External CSS URL '${node.value}' is not allowed.`, path);
      }

      if (node.type === "Raw" && /(?:url\s*\(|@import|javascript:|https?:\/\/)/iu.test(node.value)) {
        issue(issues, "CSS_RAW_NETWORK_VALUE", "Unparsed CSS may not contain URL or import expressions.", path);
      }
    });
  } catch (error) {
    issue(
      issues,
      error instanceof Error && error.message === "CSS_COMPLEXITY_LIMIT" ? "CSS_TOO_COMPLEX" : "CSS_PARSE_ERROR",
      error instanceof Error && error.message === "CSS_COMPLEXITY_LIMIT" ? "CSS exceeds the complexity limit." : "CSS could not be parsed.",
      path
    );
  }
}

function textContent(node: HtmlNode): string {
  if (node.nodeName === "#text") return node.value ?? "";
  return (node.childNodes ?? []).map(textContent).join("");
}

function validateHtml(content: string, path: string, issues: RepositoryValidationIssue[]) {
  let root: HtmlNode;
  try {
    root = parse(content, { sourceCodeLocationInfo: true }) as unknown as HtmlNode;
  } catch {
    issue(issues, "HTML_PARSE_ERROR", "HTML could not be parsed.", path);
    return;
  }

  let nodes = 0;
  const visit = (node: HtmlNode, depth: number, inSvg: boolean) => {
    nodes += 1;
    if (nodes > MAX_HTML_NODES) {
      issue(issues, "HTML_TOO_COMPLEX", `HTML exceeds ${MAX_HTML_NODES} nodes.`, path, node);
      return;
    }
    if (depth > MAX_HTML_DEPTH) {
      issue(issues, "HTML_TOO_DEEP", `HTML exceeds ${MAX_HTML_DEPTH} levels.`, path, node);
      return;
    }

    const tag = node.tagName?.toLowerCase();
    const svg = inSvg || tag === "svg";
    if (tag && !(svg ? allowedSvgTags.has(tag) : allowedHtmlTags.has(tag))) {
      issue(issues, "HTML_TAG_BLOCKED", `<${tag}> is not supported by the StructVibe profile.`, path, node);
    }

    if ((node.attrs?.length ?? 0) > 64) {
      issue(issues, "HTML_TOO_MANY_ATTRIBUTES", "An element may not contain more than 64 attributes.", path, node);
    }

    for (const attribute of node.attrs ?? []) {
      const name = `${attribute.prefix ? `${attribute.prefix}:` : ""}${attribute.name}`.toLowerCase();
      const value = attribute.value.trim();
      if (name.startsWith("on")) {
        issue(issues, "HTML_EVENT_HANDLER", `Event attribute '${name}' is not allowed.`, path, node);
        continue;
      }
      if (name === "style") {
        validateCss(attribute.value, path, issues, "declarationList");
        continue;
      }
      const allowed =
        globalAttributes.has(name) ||
        htmlAttributes.has(name) ||
        (svg && svgAttributes.has(name)) ||
        name.startsWith("aria-") ||
        name.startsWith("data-sv-") ||
        name === "href" ||
        name === "xlink:href" ||
        name === "src";
      if (!allowed) {
        issue(issues, "HTML_ATTRIBUTE_BLOCKED", `Attribute '${name}' is not supported.`, path, node);
        continue;
      }
      if ((name === "href" || name === "xlink:href") && !safeReference(value)) {
        issue(issues, "HTML_EXTERNAL_REFERENCE", `Reference '${value}' must target a local screen or SVG fragment.`, path, node);
      }
      if (name === "src" && !safeAssetReference(value)) {
        issue(issues, "HTML_EXTERNAL_ASSET", "Assets must use an immutable asset:// content hash.", path, node);
      }
      if (value.length > 100_000) {
        issue(issues, "HTML_ATTRIBUTE_TOO_LARGE", `Attribute '${name}' is too large.`, path, node);
      }
    }

    if (tag === "style") validateCss(textContent(node), path, issues);
    for (const child of node.childNodes ?? []) visit(child, depth + 1, svg);
  };

  visit(root, 0, false);
}

function validateMarkdown(content: string, path: string, issues: RepositoryValidationIssue[]) {
  if (/<\/?[A-Za-z][^>]*>/u.test(content)) {
    issue(issues, "MARKDOWN_RAW_HTML", "Raw HTML is not allowed in project Markdown.", path);
  }
}

export function validateRepositoryFiles(rawFiles: readonly RepositoryFile[]): RepositoryValidationResult {
  const issues: RepositoryValidationIssue[] = [];
  const files = rawFiles.map((file) => repositoryFileSchema.parse(file));
  const byteSize = files.reduce((total, file) => total + Buffer.byteLength(file.content, "utf8"), 0);
  const paths = new Set<string>();

  if (files.length > MAX_FILES) issue(issues, "TOO_MANY_FILES", `A repository may contain at most ${MAX_FILES} files.`);
  if (byteSize > MAX_TOTAL_BYTES) issue(issues, "REPOSITORY_TOO_LARGE", "Repository source may not exceed 20 MB.");

  for (const file of files) {
    if (paths.has(file.path)) issue(issues, "DUPLICATE_PATH", `Path '${file.path}' appears more than once.`, file.path);
    paths.add(file.path);
    if (!safeRepositoryPath(file.path) || !isRepositoryPathAllowed(file.path)) {
      issue(issues, "INVALID_REPOSITORY_PATH", `Path '${file.path}' is outside the StructVibe repository profile.`, file.path);
      continue;
    }

    try {
      if (file.path === "structvibe.json") repositoryManifestSchema.parse(JSON.parse(file.content));
      if (file.path.endsWith("/screen.json")) {
        const manifest = screenManifestSchema.parse(JSON.parse(file.content));
        const pathCode = file.path.match(/design\/screens\/(SCR-[A-Za-z0-9_-]+)\//u)?.[1];
        if (pathCode !== manifest.code) issue(issues, "SCREEN_PATH_MISMATCH", `Screen code '${manifest.code}' does not match '${pathCode}'.`, file.path);
      }
    } catch {
      issue(issues, "INVALID_JSON_DOCUMENT", `JSON in '${file.path}' does not match its repository schema.`, file.path);
    }

    if (file.path.endsWith(".html")) validateHtml(file.content, file.path, issues);
    if (file.path.endsWith(".css")) validateCss(file.content, file.path, issues);
    if (file.path.endsWith(".md")) validateMarkdown(file.content, file.path, issues);
  }

  for (const requiredPath of ["structvibe.json", "overview.md", "design/tokens.css"]) {
    if (!paths.has(requiredPath)) issue(issues, "REQUIRED_FILE_MISSING", `Repository requires '${requiredPath}'.`, requiredPath);
  }

  for (const path of paths) {
    const screenRoot = path.match(/^(design\/screens\/SCR-[A-Za-z0-9_-]+)\//u)?.[1];
    if (!screenRoot) continue;
    for (const required of [`${screenRoot}/screen.json`, `${screenRoot}/screen.html`]) {
      if (!paths.has(required)) issue(issues, "SCREEN_FILE_MISSING", `Screen requires '${required}'.`, required);
    }
  }

  return { ok: issues.length === 0, issues, fileCount: files.length, byteSize };
}

export function assertValidRepositoryFiles(files: readonly RepositoryFile[]): RepositoryValidationResult {
  const result = validateRepositoryFiles(files);
  if (!result.ok) {
    const error = new Error("Repository source did not pass validation.");
    Object.assign(error, { code: "REPOSITORY_VALIDATION_FAILED", issues: result.issues });
    throw error;
  }
  return result;
}
