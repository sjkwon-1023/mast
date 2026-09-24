// WSL 준비 상태 안내의 순수 모델 — 백엔드 진단 상태를 배너 문구·동작 목록으로
// 바꾼다. DOM 은 `banner.ts` 소유이고 여기서는 문자열만 만든다 (vitest 대상).
//
// **판정은 백엔드 계약이다.** 여기서 `wsl.exe` 존재나 준비 여부를 추측하거나
// "설치된 것 같다"는 가짜 성공을 만들지 않는다 — 상태가 `ready` 가 아니면 그대로
// 안내로 옮기고, 원문 세부 정보(`detail`)는 분류와 별개로 그대로 보여 준다.

import type { WslStatus } from "../../infrastructure/backend";

/** 배너 버튼 종류 — 렌더러는 이 목록에 있는 버튼만 보여 준다. */
export type WslAction = "copy" | "guide" | "recheck" | "settings";

export interface WslNotice {
  title: string;
  body: string;
  /** 복사 버튼이 복사할 명령 — null 이면 복사 버튼 자체를 그리지 않는다. */
  installCommand: string | null;
  actions: WslAction[];
}

/** Microsoft 의 WSL 설치 안내 (WSL 미설치·배포판 없음 상태의 "Open install guide"). */
export const WSL_INSTALL_URL = "https://learn.microsoft.com/windows/wsl/install";

/** 상태 → 안내. null 이면 배너를 숨긴다 (준비 완료 또는 이 호스트에 WSL 이 없음). */
export function wslNotice(status: WslStatus): WslNotice | null {
  switch (status.state) {
    case "notApplicable":
      return null;
    case "ready":
      if (status.missingDistros.length > 0) return missingDistroNotice(status);
      if (status.failures.length > 0) return {
        title: "WSL distribution could not start",
        body: status.failures.map((f) => `${f.distro}: ${f.detail}`).join("\n"),
        installCommand: null, actions: ["guide", "recheck", "settings"],
      };
      return null;
    case "probing":
      return {
        title: "Checking WSL…",
        body: "mast runs terminals inside WSL2 and is checking whether it is ready.",
        installCommand: null,
        actions: ["recheck"],
      };
    case "notInstalled":
      return {
        title: "WSL is not installed",
        body:
          "mast runs terminals inside WSL2. Install it from an elevated PowerShell or " +
          "Windows Terminal. Restart Windows if requested, launch the distribution and finish creating your Linux username and password, then recheck.",
        installCommand: "wsl --install",
        actions: ["copy", "guide", "recheck", "settings"],
      };
    case "noDistro":
      return {
        title: "No WSL distribution is installed",
        body:
          "WSL is installed but has no distribution. Install one (for example Ubuntu), " +
          "launch it and finish creating your Linux username and password, then recheck.",
        installCommand: "wsl --install -d Ubuntu",
        actions: ["copy", "guide", "recheck", "settings"],
      };
    case "failed":
      return {
        title: "WSL could not be queried",
        body: `mast could not list the WSL distributions${codeText(status.code)}. Fix WSL and recheck.`,
        installCommand: null,
        actions: ["guide", "recheck", "settings"],
      };
    case "timeout":
      return {
        title: "WSL did not respond",
        body:
          "The WSL distribution query did not finish in time — WSL may be starting up or " +
          "unresponsive.",
        installCommand: null,
        actions: ["recheck", "settings"],
      };
  }
}

/** 워크스페이스가 요구하는 배포판이 설치돼 있지 않다 — 설치 명령까지 안내한다. */
function missingDistroNotice(status: WslStatus): WslNotice {
  const missing = status.missingDistros;
  const first = missing[0] ?? "unknown";
  const title =
    missing.length === 1
      ? `WSL distribution "${first}" is not installed`
      : `WSL distributions ${missing.map((name) => `"${name}"`).join(", ")} are not installed`;
  const installed = status.distros.length > 0 ? status.distros.join(", ") : "none";
  return {
    title,
    body: `A workspace is set to use ${missing
      .map((name) => `"${name}"`)
      .join(", ")}, but WSL has: ${installed}. Install that distribution, or point the workspace at an installed one.`,
    installCommand: `wsl --install -d '${first.replaceAll("'", "''")}'`,
    actions: ["copy", "guide", "recheck", "settings"],
  };
}

/** 원시 종료 코드를 괄호 문구로 — HRESULT 를 8자리 16진수로 보여 준다. */
function codeText(code: number | null): string {
  if (code === null) return "";
  return ` (0x${code.toString(16).toUpperCase().padStart(8, "0")})`;
}
