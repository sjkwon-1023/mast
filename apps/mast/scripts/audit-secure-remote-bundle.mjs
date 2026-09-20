#!/usr/bin/env node
// Secure Remote 폰 번들 감사 — CI 게이트가 **실제 산출물**을 본다.
//
// 검사 대상은 `apps/mast/dist-secure-remote`(vite.secure-remote.config.ts 의 산출물)뿐이다.
// 소스나 주석은 보지 않는다 — "이 번들에는 외부 자원 참조도, 허용하지 않은 storage 접근도, 평문 HTTP
// 경로도 없다"는 계약은 소스가 아니라 GitHub Pages 가 배포하는 바이트에 걸려 있기
// 때문이다. 네트워크도 타지 않는다.
//
// 규칙.
//   missing/empty — 산출물이 없거나 비어 있으면 실패한다 (빌드에서 빠져도 조용히 통과하지 않게).
//   reference     — index.html 의 `src`/`href` 와 CSS 의 `@import`·`url()` 을 본다. 외부
//                   오리진(scheme·protocol-relative)은 거부하고, `/mast/` base 안의
//                   참조는 그 파일이 실제로 있는지 확인한다. `data:` 와 `#fragment` 는
//                   네트워크로 나가지 않으므로 허용한다.
//   CSP           — index.html 의 CSP meta 가 아래 REQUIRED_CSP 와 **정확히** 같은지 본다.
//                   존재 여부만 보면 `default-src *` 같은 약화를 통과시킨다.
//   sourcemap     — `.map` 파일이나 `sourceMappingURL` 참조가 있으면 실패한다.
//   storage       — sessionStorage·indexedDB·document.cookie·caches·navigator.storage 금지.
//                   인증된 페어링 한 건의 localStorage 사용은 소스 테스트로 검증한다.
//   plaintext     — `http://`, `fetch(`, `XMLHttpRequest`, `sendBeacon`, `/api/` (HTTP 로의 fallback).
//
// storage·plaintext 는 **문자열 마커 검사**다: 리터럴 형태와 인접 문자열 리터럴 연결
// (`"session" + "Storage"`)까지만 펴 보고, 템플릿 보간·변수 조립 같은 임의 난독화는
// 해독하지 않는다. 그래서 "임의 난독화가 불가능하다"는 증명이 아니며, 더 넓은 보증은
// 소스 리뷰 몫이다 — 이 한계는 출력과 ADR-0028 에 함께 적혀 있다.
//
// HTML 주석은 실행되지도 참조되지도 않으므로 참조·CSP·마커 검사 전에 지운다 — 주석
// 안의 예시 URL·코드를 오탐하지 않기 위해서다.
//
// 사용:
//   node scripts/audit-secure-remote-bundle.mjs dist-secure-remote
//   node scripts/audit-secure-remote-bundle.mjs --self-test
//
// `--self-test` 는 임시 디렉터리에 최소 픽스처를 만들고 각 규칙별로 오염시켜, 감사가 그
// 복사본을 **실제로 거부하는지** 확인한다 — 게이트 자체가 stub 이 아님을 같은 명령으로
// 증명한다. 이 파일은 저장소 기준으로 추적되는 개발 도구라 주석은 한국어, 출력은 영어다.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

/** 내용을 훑는 대상 확장자 — 바이너리는 없다. */
const TEXT_EXTENSIONS = new Set([".js", ".mjs", ".html", ".css"]);
const JS_EXTENSIONS = new Set([".js", ".mjs"]);

/** index.html 이 유지해야 하는 CSP. 지시문 집합을 문자열 그대로 비교한다 — 새 자원
 *  종류를 여는 변경(예: `img-src`)은 이 상수와 `secure-remote/index.html` 을 함께
 *  고쳐야 한다. Vite 는 이 meta 를 그대로 옮기므로 공백만 정규화해서 본다. */
const REQUIRED_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src https:; base-uri 'none'; form-action 'none'";

/** 인증된 페어링 한 건의 localStorage만 허용한다. 다른 저장 경로는 사용하지 않는다. */
const STORAGE_MARKERS = [
  "sessionStorage",
  "indexedDB",
  "document.cookie",
  "caches",
  "navigator.storage",
];

/** 평문 HTTP 나 그 fallback 으로 이어지는 표식. `https:` 는 통과한다. */
const PLAINTEXT_MARKERS = ["http://", "fetch(", "XMLHttpRequest", "sendBeacon", "/api/"];

function listFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(path));
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

function isTextFile(path) {
  const dot = path.lastIndexOf(".");
  return dot !== -1 && TEXT_EXTENSIONS.has(path.slice(dot).toLowerCase());
}

/** HTML 주석 제거 — 실행도 참조도 되지 않는 텍스트가 규칙에 걸리지 않게. */
function stripHtmlComments(html) {
  return html.replace(/<!--[\s\S]*?-->/g, "");
}

/** CSS 주석 제거 — 같은 이유. 압축된 산출물에는 보통 없지만, 예시로 적힌 URL 이
 *  참조로 오탐되지 않게 검사 전에 지운다. */
function stripCssComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** `<meta http-equiv="Content-Security-Policy" content="…">` 의 정책들. content 가
 *  없으면 `null` 로 남겨 호출자가 실패로 처리한다. */
function cspPolicies(html) {
  const policies = [];
  for (const tag of html.matchAll(/<meta\b[^>]*>/gi)) {
    if (!/\bhttp-equiv\s*=\s*["']Content-Security-Policy["']/i.test(tag[0])) continue;
    const content =
      tag[0].match(/\bcontent\s*=\s*"([^"]*)"/i) ?? tag[0].match(/\bcontent\s*=\s*'([^']*)'/i);
    policies.push(content === null ? null : content[1].replace(/\s+/g, " ").trim());
  }
  return policies;
}

/** `src`/`href` 속성값 (작은따옴표 포함). */
function referenceValues(html) {
  const values = [];
  for (const match of html.matchAll(/\b(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    values.push(match[1] ?? match[2] ?? "");
  }
  return values;
}

/** CSS 의 `@import`·`url()` 대상. url() 안의 따옴표는 선택이다. `@import url(…)`
 *  처럼 두 규칙에 다 걸리는 값은 한 번만 돌려준다 — 실패 목록이 중복되지 않게. */
function cssReferenceValues(css) {
  const values = new Set();
  for (const match of css.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^'")]*))\s*\)/gi)) {
    values.add(match[1] ?? match[2] ?? match[3] ?? "");
  }
  for (const match of css.matchAll(
    /@import\s+(?:"([^"]*)"|'([^']*)'|url\(\s*(?:"([^"]*)"|'([^']*)'|([^'")]*))\s*\))/gi,
  )) {
    values.add(match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5] ?? "");
  }
  return [...values];
}

/** 참조 값 하나의 분류. `local` 은 base(root 또는 CSS 파일 디렉터리) 기준의 상대
 *  경로이고, `absolute` 는 `/mast/` 접두사가 있었다는 뜻이다. */
function classifyReference(value) {
  const url = value.trim();
  const lower = url.toLowerCase();
  if (url === "") return { kind: "empty" };
  if (lower.startsWith("#") || lower.startsWith("data:")) return { kind: "inline" };
  if (url.startsWith("//")) return { kind: "external" };
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)) return { kind: "external" };
  const path = url.split(/[?#]/, 1)[0];
  if (path === "") return { kind: "inline" };
  if (path.startsWith("/mast/")) {
    const rel = path.slice("/mast/".length);
    return { kind: "local", absolute: true, rel: rel.endsWith("/") ? `${rel}index.html` : rel };
  }
  if (path.startsWith("/")) return { kind: "outside-base" };
  return { kind: "local", absolute: false, rel: path.endsWith("/") ? `${path}index.html` : path };
}

/** bundle 밖으로 나가는 참조(`/mast/../../etc/…`)를 거른다. 실패하면 `null`. */
function resolveInside(root, rel) {
  let normalized = rel;
  try {
    normalized = decodeURIComponent(rel);
  } catch {
    // 잘못된 퍼센트 인코딩은 원문 그대로 확인한다 — 없으면 어차피 missing 이다.
  }
  const target = resolve(root, normalized);
  const guard = resolve(root);
  if (target !== guard && !target.startsWith(guard + sep)) return null;
  return target;
}

/** 참조 값 목록을 검사한다. `root` 는 `/mast/` 의 실체 디렉터리, `relativeBase` 는
 *  상대 경로의 기준(HTML 은 root, CSS 는 그 파일의 디렉터리)이다. */
function checkReferenceValues(values, label, root, relativeBase, failures) {
  for (const value of values) {
    const ref = classifyReference(value);
    if (ref.kind === "inline") continue;
    if (ref.kind === "empty") {
      failures.push(`empty reference in ${label}`);
      continue;
    }
    if (ref.kind === "external") {
      failures.push(`external reference in ${label}: ${value.trim()}`);
      continue;
    }
    if (ref.kind === "outside-base") {
      failures.push(`reference outside /mast/ in ${label}: ${value.trim()}`);
      continue;
    }
    const target = resolveInside(ref.absolute ? root : relativeBase, ref.rel);
    if (target === null || !existsSync(target)) {
      failures.push(`missing reference in ${label}: ${value.trim()}`);
    }
  }
}

/** 인접한 문자열 리터럴 연결(`"session" + "Storage"`)만 펴는 유계 변환. 따옴표류와 그
 *  사이의 `+` 를 지우므로 `globalThis["session"+"Storage"]` 가 `sessionStorage` 로 드러난다.
 *  템플릿 보간(`${…}`)·변수 조립은 이 변환의 범위가 아니다 (모듈 헤더의 한계). */
function foldConcatenatedLiterals(text) {
  return text.replace(/(["'`])\s*\+\s*(["'`])/g, "$1$2").replace(/["'`]/g, "");
}

/** 산출물 디렉터리 하나를 검사한다. 반환값은 실패 메시지 목록 (빈 배열이면 통과). */
export function auditBundle(dir) {
  const failures = [];
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    return [`missing artifact directory: ${dir}`];
  }

  const indexPath = join(dir, "index.html");
  if (!existsSync(indexPath)) failures.push("missing index.html");

  const files = listFiles(dir);
  const rel = (path) => relative(dir, path).split(sep).join("/");
  const assets = files.filter((path) => rel(path).startsWith("assets/"));
  const html = existsSync(indexPath) ? stripHtmlComments(readFileSync(indexPath, "utf8")) : "";

  if (existsSync(indexPath) && html.trim() === "") failures.push("empty index.html");
  if (assets.length === 0) failures.push("missing assets directory");
  const jsAssets = assets.filter((path) => JS_EXTENSIONS.has(path.slice(path.lastIndexOf("."))));
  const cssAssets = assets.filter((path) => path.endsWith(".css"));
  if (jsAssets.length === 0) failures.push("missing JavaScript asset");
  if (cssAssets.length === 0) failures.push("missing stylesheet asset");
  for (const path of [...jsAssets, ...cssAssets]) {
    if (statSync(path).size === 0) failures.push(`empty asset: ${rel(path)}`);
  }

  if (existsSync(indexPath)) {
    if (!html.includes("/mast/assets/")) {
      failures.push("base path lost in index.html (no /mast/assets/ reference)");
    }
    checkReferenceValues(referenceValues(html), "index.html", dir, dir, failures);
    const policies = cspPolicies(html);
    if (policies.length === 0) failures.push("CSP meta missing in index.html");
    for (const policy of policies) {
      if (policy === null) failures.push("CSP meta has no content attribute in index.html");
      else if (policy !== REQUIRED_CSP) {
        failures.push(`CSP is not the required policy in index.html (got: "${policy}")`);
      }
    }
  }

  for (const path of files.filter((file) => file.endsWith(".css"))) {
    const label = rel(path);
    checkReferenceValues(
      cssReferenceValues(stripCssComments(readFileSync(path, "utf8"))),
      label,
      dir,
      dirname(path),
      failures,
    );
  }

  for (const path of files) {
    const name = rel(path);
    if (name.endsWith(".map")) failures.push(`sourcemap file present: ${name}`);
    if (!isTextFile(path)) continue;
    const raw = readFileSync(path, "utf8");
    const isHtml = name.endsWith(".html");
    // 주석은 실행되지 않는다 — HTML 은 주석을 지운 텍스트로 판정한다 (오탐 방지).
    const text = isHtml ? stripHtmlComments(raw) : raw;
    if (raw.includes("sourceMappingURL")) failures.push(`sourcemap reference in ${name}`);
    // 저장소·평문 HTTP 는 실행되는 코드(JS)와 문서(HTML)에만 걸린다 — CSS 의
    // `http://www.w3.org/...` 같은 네임스페이스 문자열을 오탐하지 않기 위해서다.
    if (JS_EXTENSIONS.has(path.slice(path.lastIndexOf("."))) || isHtml) {
      const folded = foldConcatenatedLiterals(text);
      for (const marker of STORAGE_MARKERS) {
        if (text.includes(marker)) failures.push(`storage API "${marker}" in ${name}`);
        else if (folded.includes(marker)) {
          failures.push(`concealed storage API "${marker}" (string-splitting form) in ${name}`);
        }
      }
      for (const marker of PLAINTEXT_MARKERS) {
        if (text.includes(marker)) failures.push(`plaintext/HTTP fallback marker "${marker}" in ${name}`);
        else if (folded.includes(marker)) {
          failures.push(
            `concealed plaintext/HTTP fallback marker "${marker}" (string-splitting form) in ${name}`,
          );
        }
      }
    }
  }

  return failures;
}

const FIXTURE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="UTF-8" />
<!-- 아래는 예시일 뿐 실행되지 않는 참조다: <script src="https://cdn.example/app.js"></script> -->
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self'; connect-src https:; base-uri 'none'; form-action 'none'" />
<script type="module" src="/mast/assets/app.js"></script>
<link rel="stylesheet" href="/mast/assets/app.css">
</head><body><div id="app"></div></body></html>
`;
const FIXTURE_JS = `const url = "https://";\n`;
// 주석 안의 예시 URL 은 참조가 아니다 — valid 픽스처 통과가 그 오탐 방지의 잠금이다.
const FIXTURE_CSS = `body { color: #fff; }\n/* 예시: url(https://cdn.example/bg.png) */\n`;

function writeFixture(dir) {
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(join(dir, "index.html"), FIXTURE_HTML);
  writeFileSync(join(dir, "assets", "app.js"), FIXTURE_JS);
  writeFileSync(join(dir, "assets", "app.css"), FIXTURE_CSS);
}

/** 규칙별 오염 — `expected` 는 감사가 돌려줘야 하는 실패 메시지의 일부다. */
const TAMPERS = [
  ["sourcemap comment", "sourcemap reference", (dir) => writeFileSync(join(dir, "assets", "app.js"), FIXTURE_JS + "//# sourceMappingURL=app.js.map\n")],
  ["sourcemap file", "sourcemap file present", (dir) => writeFileSync(join(dir, "assets", "app.js.map"), "{}\n")],
  ["storage sessionStorage", 'storage API "sessionStorage"', (dir) => writeFileSync(join(dir, "assets", "app.js"), FIXTURE_JS + "sessionStorage.setItem('t', '1');\n")],
  ["storage indexedDB", 'storage API "indexedDB"', (dir) => writeFileSync(join(dir, "assets", "app.js"), FIXTURE_JS + "indexedDB.open('t');\n")],
  ["storage computed concat", 'concealed storage API "sessionStorage"', (dir) => writeFileSync(join(dir, "assets", "app.js"), FIXTURE_JS + 'globalThis["session"+"Storage"].setItem("t", "1");\n')],
  ["plaintext fetch", 'plaintext/HTTP fallback marker "fetch("', (dir) => writeFileSync(join(dir, "assets", "app.js"), FIXTURE_JS + "fetch('/api/state');\n")],
  ["plaintext http", 'plaintext/HTTP fallback marker "http://"', (dir) => writeFileSync(join(dir, "assets", "app.js"), FIXTURE_JS + "const plain = 'http://10.0.0.1:7331';\n")],
  ["plaintext computed concat", 'concealed plaintext/HTTP fallback marker "http://"', (dir) => writeFileSync(join(dir, "assets", "app.js"), FIXTURE_JS + 'const plain = "ht" + "tp://10.0.0.1:7331";\n')],
  ["xhr fallback", 'plaintext/HTTP fallback marker "XMLHttpRequest"', (dir) => writeFileSync(join(dir, "assets", "app.js"), FIXTURE_JS + "new XMLHttpRequest();\n")],
  ["base lost", "base path lost", (dir) => writeFileSync(join(dir, "index.html"), FIXTURE_HTML.replaceAll("/mast/assets/", "/assets/"))],
  ["csp lost", "CSP meta missing", (dir) => writeFileSync(join(dir, "index.html"), FIXTURE_HTML.replace(/<meta http-equiv="Content-Security-Policy"[\s\S]*?\/>\n/, ""))],
  ["csp weakened", "CSP is not the required policy", (dir) => writeFileSync(join(dir, "index.html"), FIXTURE_HTML.replace(/content="default-src[^"]*"/, `content="default-src *; script-src 'self'; style-src 'self'; connect-src https:"`))],
  ["csp directive dropped", "CSP is not the required policy", (dir) => writeFileSync(join(dir, "index.html"), FIXTURE_HTML.replace("; base-uri 'none'", ""))],
  ["external script", "external reference in index.html: https://cdn.example/app.js", (dir) => writeFileSync(join(dir, "index.html"), FIXTURE_HTML.replace('src="/mast/assets/app.js"', 'src="https://cdn.example/app.js"'))],
  ["protocol-relative script", "external reference in index.html: //cdn.example/app.js", (dir) => writeFileSync(join(dir, "index.html"), FIXTURE_HTML.replace('src="/mast/assets/app.js"', 'src="//cdn.example/app.js"'))],
  ["external stylesheet", "external reference in index.html: https://cdn.example/app.css", (dir) => writeFileSync(join(dir, "index.html"), FIXTURE_HTML.replace('href="/mast/assets/app.css"', 'href="https://cdn.example/app.css"'))],
  ["missing asset", "missing reference in index.html: /mast/assets/missing.js", (dir) => writeFileSync(join(dir, "index.html"), FIXTURE_HTML.replace('src="/mast/assets/app.js"', 'src="/mast/assets/missing.js"'))],
  ["css external import", "external reference in assets/app.css: https://cdn.example/theme.css", (dir) => writeFileSync(join(dir, "assets", "app.css"), FIXTURE_CSS + '@import url("https://cdn.example/theme.css");\n')],
  ["css protocol-relative url", "external reference in assets/app.css: //cdn.example/bg.png", (dir) => writeFileSync(join(dir, "assets", "app.css"), FIXTURE_CSS + "body { background: url(//cdn.example/bg.png); }\n")],
  ["css missing resource", "missing reference in assets/app.css: ./missing.woff2", (dir) => writeFileSync(join(dir, "assets", "app.css"), FIXTURE_CSS + "@font-face { src: url(./missing.woff2); }\n")],
  ["index removed", "missing index.html", (dir) => rmSync(join(dir, "index.html"))],
  ["asset emptied", "empty asset", (dir) => writeFileSync(join(dir, "assets", "app.js"), "")],
  ["assets removed", "missing assets directory", (dir) => rmSync(join(dir, "assets"), { recursive: true })],
];

function runSelfTest() {
  const root = mkdtempSync(join(tmpdir(), "mast-secure-remote-audit-"));
  const failures = [];
  try {
    const valid = join(root, "valid");
    writeFixture(valid);
    const validFailures = auditBundle(valid);
    if (validFailures.length !== 0) {
      failures.push(`valid fixture was rejected: ${validFailures.join("; ")}`);
    }

    for (const [name, expected, tamper] of TAMPERS) {
      const dir = join(root, "case");
      rmSync(dir, { recursive: true, force: true });
      writeFixture(dir);
      tamper(dir);
      const found = auditBundle(dir);
      if (found.length === 0) {
        failures.push(`tamper "${name}" was accepted`);
      } else if (!found.some((message) => message.includes(expected))) {
        failures.push(`tamper "${name}" failed without the expected reason: ${found.join("; ")}`);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  if (failures.length !== 0) {
    for (const message of failures) console.error(`FAIL: ${message}`);
    console.error(`FAIL self-test: ${failures.length} case(s) wrong`);
    return 1;
  }
  console.log(`PASS self-test: valid fixture accepted, ${TAMPERS.length} tampered copies rejected`);
  return 0;
}

function main(argv) {
  if (argv.includes("--self-test")) return runSelfTest();
  const dir = argv[0] ?? "dist-secure-remote";
  const failures = auditBundle(dir);
  if (failures.length !== 0) {
    for (const message of failures) console.error(`FAIL: ${message}`);
    console.error(`FAIL secure-remote bundle audit: ${failures.length} problem(s) in ${dir}`);
    return 1;
  }
  console.log(
    `PASS secure-remote bundle audit: ${dir} (base + resolved references, exact CSP, no sourcemaps, no disallowed storage/HTTP markers in text)`,
  );
  return 0;
}

process.exitCode = main(process.argv.slice(2));
