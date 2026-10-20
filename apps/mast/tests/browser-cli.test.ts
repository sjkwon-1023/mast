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
  it("parses eval expressions, stdin, --, and bounded timeouts", () => {
    const output = run(`args=b.parser().parse_args(['eval','#42','document.title'])\nassert b.make_request(args)=={'action':'eval','tab':42,'args':{'expression':'document.title','timeoutMs':5000}}\nargs=b.parser().parse_args(['eval','42','--timeout-ms','10000','--','-window.name'])\nassert b.make_request(args)['args']=={'expression':'-window.name','timeoutMs':10000}\nargs=b.parser().parse_args(['eval','42','-'])\nb.sys.stdin=__import__('io').StringIO('document.URL')\nassert b.make_request(args)['args']['expression']=='document.URL'\nprint('ok')`);
    expect(output).toBe("ok\n");
  });
  it("rejects empty eval expressions and timeouts outside 1..10000", () => {
    run(`for argv in (['eval','42',''], ['eval','42','1','--timeout-ms','0'], ['eval','42','1','--timeout-ms','10001']):\n args=b.parser().parse_args(argv)\n try: b.make_request(args)\n except ValueError: pass\n else: raise AssertionError('accepted invalid eval arguments')`);
  });
  it("uses separate deadlines for the eval token and request round trips", () => {
    const output = run(`calls=[]\ntimes=iter([100.0,105.0])\noriginal_monotonic=b.time.monotonic\nb.time.monotonic=lambda: next(times)\ndef query_once(request, deadline):\n calls.append((request,deadline))\n return 'A'*43 if request['action']=='eval-token' else {'value':42}\nb._query_once=query_once\ntry:\n result=b.query({'action':'eval','tab':42,'args':{'expression':'21*2','timeoutMs':5000}})\nfinally: b.time.monotonic=original_monotonic\nassert calls[0][0]=={'action':'eval-token','args':{}}\nassert calls[1][0]=={'action':'eval','tab':42,'args':{'expression':'21*2','timeoutMs':5000,'token':'A'*43}}\nassert calls[0][1]==110.0 and calls[1][1]==165.0\nassert result=={'value':42}\nprint('ok')`);
    expect(output).toBe("ok\n");
  });
  it("does not write a browser request after its deadline expires", () => {
    run(`b.os.environ['MAST']='1'\nwrites=[]\nb._write_terminal=writes.append\noriginal_monotonic=b.time.monotonic\nb.time.monotonic=lambda: 10.0\ntry:\n try: b._query_once({'action':'list','args':{}},10.0)\n except TimeoutError: pass\n else: raise AssertionError('expired request was accepted')\nfinally: b.time.monotonic=original_monotonic\nassert writes==[]`);
  });
  it.runIf(process.platform === "darwin")("reaches MAST_TTY when the shell has no controlling tty", () => {
    const output = run(`import os\nos.setsid()\nmaster, slave = os.openpty()\nb.os.environ.update(MAST='1', MAST_TTY=os.ttyname(slave))\nb._write_terminal(b'\\x1b]777;probe\\x07')\nprint(os.read(master, 64))`);
    expect(output).toContain("777;probe");
  });
  it("documents a one-line heredoc invocation in eval help", () => {
    const output = run(`args=b.parser().parse_args(['eval','--help'])`);
    expect(output).toContain("mast browser eval T - <<'JS' ... JS");
  });
  it("writes a screenshot locally and never overwrites an existing file", () => {
    run(`with tempfile.TemporaryDirectory() as directory:\n p=pathlib.Path(directory)/'capture.png'\n result={'data':'iVBORw0KGgo='}\n assert b.save_screenshot(result,p)['path']==str(p.resolve())\n try: b.save_screenshot(result,p)\n except FileExistsError: pass\n else: raise AssertionError('overwrote existing screenshot')`);
  });
  it("parses fixed screenshot dimensions and omits the default height", () => {
    const output = run(`args=b.parse_args(['screenshot','42'])\nassert b.make_request(args)=={'action':'screenshot','tab':42,'args':{}}\nargs=b.parse_args(['screenshot','#42','--width','1280'])\nassert b.make_request(args)=={'action':'screenshot','tab':42,'args':{'width':1280}}\nargs=b.parse_args(['screenshot','42','--width','1280','--height','720'])\nassert b.make_request(args)=={'action':'screenshot','tab':42,'args':{'width':1280,'height':720}}\nwith tempfile.TemporaryDirectory() as directory:\n result=b.save_screenshot({'data':'iVBORw0KGgo=','width':1280,'height':800},pathlib.Path(directory)/'capture.png')\n assert result['width']==1280 and result['height']==800`);
    expect(output).toBe("");
  });
  it("rejects out-of-range screenshot dimensions and height without width", () => {
    const output = run(`for argv in (['screenshot','42','--width','319'], ['screenshot','42','--width','3841'], ['screenshot','42','--height','720']):\n try: b.parse_args(argv)\n except SystemExit as error: assert error.code==2\n else: raise AssertionError('accepted invalid screenshot dimensions')`);
    expect(output).toBe("");
  });
  it("keeps the browser query prefix, the error envelope text and the 24 MiB reply cap by default", () => {
    const output = run(`import base64\nb.os.environ['MAST']='1'\nsent=[]\ndef answer(sequence):\n sent.append(sequence)\n reply=pathlib.Path(base64.b64decode(sequence.rstrip(b'\\x07').split(b';')[-1]).decode())\n reply.write_bytes(b'{"error":{"code":"x","message":"y"}}' if len(sent)==1 else b'x'*(24*1024*1024+1))\nb._write_terminal=answer\ntry: b._query_once({'action':'list','args':{}}, b.time.monotonic()+5)\nexcept ValueError as error: assert error.error=={'code':'x','message':'y'} and str(error)=='{"code": "x", "message": "y"}', str(error)\nelse: raise AssertionError('error envelope accepted')\ntry: b._query_once({'action':'list','args':{}}, b.time.monotonic()+5)\nexcept ValueError as error: assert str(error)=='browser reply exceeds 24 MiB', str(error)\nelse: raise AssertionError('oversize reply accepted')\nassert all(s.startswith(b'\\x1b]777;mast-query;browser:') for s in sent)\nprint('ok')`);
    expect(output).toBe("ok\n");
  });
});
