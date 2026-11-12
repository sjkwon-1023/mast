// 이미지 확장자 표 — 확장자 분기(`viewerTabForPath`)와 Blob MIME(`ImageView`)의
// 단일 출처다. DOM 에 닿지 않으므로 폴더 뷰가 이미지 뷰 클래스 모듈을 import 하지
// 않고도 같은 표를 쓸 수 있다.
//
// basename 의 마지막 점 뒤만 보고 ASCII 대소문자를 무시한다. 선두 점은 dotfile
// 표시이지 확장자가 아니다 (`/.png` 는 확장자 없음, `/.hidden.webp` 는 webp).

const IMAGE_MIME_TYPES: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
};

/** basename 의 마지막 확장자 (소문자, 점 포함). 없으면 빈 문자열. */
export function lowerExtension(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot) : "";
}

/** 표에 있는 확장자의 Blob MIME. 표에 없으면 null (MIME 을 지정하지 않는다). */
export function imageMimeType(path: string): string | null {
  return IMAGE_MIME_TYPES[lowerExtension(path)] ?? null;
}

/** 이미지 뷰어로 여는 확장자인가. */
export function isImagePath(path: string): boolean {
  return lowerExtension(path) in IMAGE_MIME_TYPES;
}
