// @vitest-environment node
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
const script = readFileSync(new URL("../../../src-tauri/src/browser-page.js", import.meta.url), "utf8");
const evalScript = readFileSync(new URL("../../../src-tauri/src/browser-eval.js", import.meta.url), "utf8");
function page() {
  const window = new Window({url: "http://localhost:3000", settings: {enableJavaScriptEvaluation: true}});
  window.document.body.innerHTML = '<input aria-label="Name"><button>Save</button><p>Ready</p>';
  for (const element of window.document.querySelectorAll("input,button")) Object.defineProperty(element, "getClientRects", {value: () => [{}]});
  window.eval(script);
  return window;
}
function run(window: Window, action: string, args = {}) {
  return window.eval(`window.__mastBrowser.run(${JSON.stringify(action)},${JSON.stringify(args)})`);
}
function evaluate(window: Window, expression: string) {
  const body = evalScript.replace("__MAST_EVAL_EXPRESSION__", `\n${expression}\n`);
  return window.eval(`(async function(){\n${body}\n})()`);
}
describe("browser page automation", () => {
  it("snapshots, fills and clicks the same page using refs", async () => {
    const window = page();
    try {
      const snapshot = run(window, "snapshot");
      const input = snapshot.elements.find((e: {tag:string}) => e.tag === "input");
      const button = snapshot.elements.find((e: {tag:string}) => e.tag === "button");
      let clicked = false;
      window.document.querySelector("button")!.addEventListener("click", () => {clicked = true;});
      expect(run(window, "fill", {ref: input.ref, text: "안녕"})).toEqual({ok: true});
      expect(window.document.querySelector("input")!.value).toBe("안녕");
      run(window, "click", {ref: button.ref}); expect(clicked).toBe(true);
    } finally { await window.happyDOM.close(); }
  });
  it("rejects refs from a previous snapshot or removed element", async () => {
    const window = page();
    try {
      const ref = run(window, "snapshot").elements[0].ref;
      run(window, "snapshot");
      expect(run(window, "fill", {ref, text: "wrong"}).error).toBe("stale_ref");
      const current = run(window, "snapshot").elements[0].ref;
      window.document.querySelector("input")!.remove();
      expect(run(window, "click", {ref: current}).error).toBe("stale_ref");
    } finally { await window.happyDOM.close(); }
  });
  it("bounds console history and returns page errors", async () => {
    const window = page();
    try {
      window.eval("for(let i=0;i<150;i++) console.log('entry '+i)");
      expect(run(window, "console").entries).toHaveLength(100);
      window.dispatchEvent(new window.ErrorEvent("error", {message: "page failed"}));
      expect(run(window, "errors").entries[0].message).toBe("page failed");
    } finally { await window.happyDOM.close(); }
  });

  it("serializes values, awaits promises, and maps undefined to null", async () => {
    const window = page();
    try {
      expect(JSON.parse(await evaluate(window, "21 * 2"))).toEqual({value: 42});
      expect(JSON.parse(await evaluate(window, "Promise.resolve({ok: true})"))).toEqual({value: {ok: true}});
      expect(JSON.parse(await evaluate(window, "undefined"))).toEqual({value: null});
      expect(JSON.parse(await evaluate(window, "({toJSON() { return undefined; }})"))).toEqual({value: null});
    } finally { await window.happyDOM.close(); }
  });

  it("normalizes throws and rejections without leaking them into the page result", async () => {
    const window = page();
    try {
      expect(JSON.parse(await evaluate(window, "(() => { throw null; })()"))).toEqual({
        error: {code: "script_error", name: "Error", message: "null"},
      });
      expect(JSON.parse(await evaluate(window, "Promise.reject('rejected')"))).toEqual({
        error: {code: "script_error", name: "Error", message: "rejected"},
      });
      expect(JSON.parse(await evaluate(window, "(() => { const error = {}; Object.defineProperty(error, 'message', {get() { throw null; }}); error.toString = () => { throw 'bad'; }; throw error; })()")))
        .toEqual({error: {code: "script_error", name: "Error", message: "[exception message unavailable]"}});
      const oversizedMessage = JSON.parse(await evaluate(window, "(() => { throw '한'.repeat(3000); })()"));
      expect(new TextEncoder().encode(oversizedMessage.error.message).length).toBeLessThanOrEqual(4096);
      const oversizedNameEnvelope = await evaluate(window, "(() => { throw {name: 'x'.repeat(300000), message: 'boom'}; })()");
      const oversizedName = JSON.parse(oversizedNameEnvelope);
      expect(new TextEncoder().encode(oversizedName.error.name).length).toBeLessThanOrEqual(256);
      expect(new TextEncoder().encode(oversizedNameEnvelope).length).toBeLessThanOrEqual(8192);
    } finally { await window.happyDOM.close(); }
  });

  it("reports serialization failures and caps UTF-8 and escaped JSON results", async () => {
    const window = page();
    try {
      expect(JSON.parse(await evaluate(window, "1n"))).toMatchObject({error: {code: "serialization_error"}});
      expect(JSON.parse(await evaluate(window, "(() => { const value = {}; value.self = value; return value; })()")))
        .toMatchObject({error: {code: "serialization_error"}});
      expect(JSON.parse(await evaluate(window, "({get value() { throw 'getter failed'; }})")))
        .toMatchObject({error: {code: "serialization_error"}});
      expect(JSON.parse(await evaluate(window, "(() => { let reads = 0; return {toJSON() { throw {get message() { return ++reads === 1 ? 'original' : 7; }}; }}; })()")))
        .toEqual({error: {code: "serialization_error", name: "Error", message: "original"}});
      expect(JSON.parse(await evaluate(window, "'한'.repeat(400000)"))).toEqual({error: {code: "too_large"}});
      expect(JSON.parse(await evaluate(window, "'\\n'.repeat(600000)"))).toEqual({error: {code: "too_large"}});
    } finally { await window.happyDOM.close(); }
  });
});
