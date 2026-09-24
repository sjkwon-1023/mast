// 클립보드 복사 — WSL 안내 배너의 "Copy install command" 뒤에 있다.
//
// `navigator.clipboard` 는 WebView2(Chromium)에서 보안 컨텍스트 + 사용자 제스처가
// 있으면 동작하지만, 권한이 거부되거나 API 가 없을 수 있다. 그때는 임시 textarea +
// `document.execCommand("copy")` 로 내려간다 (deprecated 지만 WebView2 에서 여전히
// 동작한다). 실패는 성공으로 가리지 않고 false 로 돌려준다 — 호출자가 안내한다.

export async function copyText(text: string): Promise<boolean> {
  if (text === "") return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // 아래 fallback 으로 내려간다.
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    const copied = document.execCommand("copy");
    area.remove();
    return copied;
  } catch {
    return false;
  }
}
