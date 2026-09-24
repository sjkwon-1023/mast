// @vitest-environment node
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
const script = readFileSync(new URL("../../../src-tauri/src/browser-page.js", import.meta.url), "utf8");
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
});
