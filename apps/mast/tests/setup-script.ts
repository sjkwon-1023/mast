import { readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TAURI_SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../src-tauri/src");

export const PROVISION_RS = resolve(TAURI_SRC, "provision.rs");

export type EmbeddedFile = {
  placeholder: string;
  delimiter: string;
  path: string;
  installedName: string;
};

export function provisionSource(): string {
  return readFileSync(PROVISION_RS, "utf8");
}

export function setupVersion(source = provisionSource()): number {
  const match = source.match(/^const SETUP_VERSION: u32 = (\d+);$/m);
  if (!match) throw new Error("SETUP_VERSION disappeared from provision.rs");
  return Number(match[1]);
}

// 치환 목록을 따로 적어 두면 provision.rs 에 파일이 추가돼도 테스트는 옛 목록으로 조용히 통과한다.
export function embeddedFiles(source = provisionSource()): EmbeddedFile[] {
  const table = source.match(/const EMBEDDED_FILES: \[\(&str, &str, &str\); (\d+)\] = \[([\s\S]*?)\n\];/);
  if (!table) throw new Error("EMBEDDED_FILES disappeared from provision.rs");
  const entries = [...table[2].matchAll(/\(\s*"(@[A-Z_]+@)",\s*"([A-Z_]+)",\s*include_str!\("([^"]+)"\),?\s*\)/g)];
  if (entries.length !== Number(table[1])) {
    throw new Error(`EMBEDDED_FILES declares ${table[1]} entries but ${entries.length} were parsed`);
  }
  return entries.map(([, placeholder, delimiter, relative]) => {
    const path = resolve(TAURI_SRC, relative);
    return { placeholder, delimiter, path, installedName: basename(path) };
  });
}

export function rawSetupScript(source = provisionSource()): string {
  const raw = source.split('const SETUP_SCRIPT: &str = r###"')[1]?.split('"###;')[0];
  if (raw === undefined) throw new Error("SETUP_SCRIPT disappeared from provision.rs");
  return raw;
}

// provision.rs 의 setup_script() 와 같은 치환이다. 앞의 CRLF 정규화는 rustc 가 소스 리터럴에 하는
// 일을 대신한다(이 파일은 provision.rs 를 디스크에서 그대로 읽는다). split/join 을 쓰는 이유는
// String.replace 가 파일 내용의 `$&`·`$$` 같은 패턴을 치환 규칙으로 해석하기 때문이다.
export function assembleSetupScript(source = provisionSource()): string {
  let script = rawSetupScript(source)
    .replaceAll("\r\n", "\n")
    .split("@SETUP_VERSION@")
    .join(String(setupVersion(source)));
  for (const file of embeddedFiles(source)) {
    script = script.split(`${file.placeholder}\n`).join(readFileSync(file.path, "utf8"));
  }
  return script.replaceAll("\r\n", "\n");
}
