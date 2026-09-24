// @vitest-environment node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
const helper = fileURLToPath(new URL("../../../scripts/wsl/mast-browser.py", import.meta.url));
function run(code: string) {
  const script = `import importlib.util, json, pathlib, tempfile\nspec=importlib.util.spec_from_file_location('browser', ${JSON.stringify(helper)})\nb=importlib.util.module_from_spec(spec)\nspec.loader.exec_module(b)\n${code}`;
  const result = spawnSync("python3", ["-c", script], {encoding: "utf8", timeout: 5000});
  if (result.error) throw result.error;
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}
describe("browser CLI", () => {
  it("keeps quotes and shell syntax as JSON input without executing it", () => {
    const output = run(`args=b.parser().parse_args(['fill','#42','ref:1',"a; $(echo nope) 'quote'"])\nprint(json.dumps(b.make_request(args)))`);
    expect(JSON.parse(output)).toEqual({action: "fill", tab: 42, args: {ref: "ref:1", text: "a; $(echo nope) 'quote'"}});
  });
  it("validates bounded waits before transmitting", () => {
    run(`args=b.parser().parse_args(['wait','42','--timeout-ms','999999'])\ntry: b.make_request(args)\nexcept ValueError: pass\nelse: raise AssertionError('unbounded wait')`);
  });
  it("writes a screenshot locally and never overwrites an existing file", () => {
    run(`with tempfile.TemporaryDirectory() as directory:\n p=pathlib.Path(directory)/'capture.png'\n result={'data':'iVBORw0KGgo='}\n assert b.save_screenshot(result,p)['path']==str(p)\n try: b.save_screenshot(result,p)\n except FileExistsError: pass\n else: raise AssertionError('overwrote existing screenshot')`);
  });
});
