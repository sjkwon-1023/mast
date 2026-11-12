// imageViewer 탭의 뷰 — 파일을 4MiB 청크로 읽어 Blob URL 하나로 보여 준다.
//
// 읽기 계약 (ADR-0008 이미지 뷰어 보강 기록):
// - 마운트와 실제 path 변경에서만 읽는다. 같은 path 의 스냅샷 갱신은 아무 것도
//   다시 하지 않는다.
// - fsStat 으로 먼저 확인하고 디렉터리·stat 실패·64MiB 초과는 본문을 읽지 않는다.
//   stat 뒤에 파일이 커졌어도 누적이 상한을 넘으면 그 자리에서 멈춘다.
// - 동시에 진행하는 읽기는 하나이고, 청크 요청은 4MiB 이하로 offset 을 이어 간다.
//   짧거나 빈 응답이 EOF 다.
// - 표시는 Blob URL 을 쓰는 <img> 하나다. MIME 은 확장자 표에서만 정하고 표에
//   없으면 지정하지 않는다 — image/svg+xml 은 어떤 경우에도 주지 않는다.
//   올바른 이미지인지는 WebView 디코더의 load/error 가 판정한다.
// - dispose·path 변경·실패 때 URL 을 revoke 하고 src·버퍼 참조를 놓는다. 그 뒤에
//   도착한 stat·청크·load·error 결과는 전부 버리고 다음 요청을 시작하지 않는다.
//
// 맞춤/원본은 모델에 저장하지 않는 임시 상태다. 맞춤이 기본이고 pane 보다 작은
// 이미지는 키우지 않는다. 원본에서는 스크롤 컨테이너가 가로·세로로 넘친다.

import { fsReadChunk, fsStat } from "../../../infrastructure/backend";
import type { ViewerKind, ViewerView } from "../viewer-view";
import { setBanner } from "../viewer-view";
import { imageMimeType } from "./extensions";

/** 파일 크기 상한 — 같으면 허용하고 넘으면 거부한다. */
export const IMAGE_MAX_BYTES = 64 * 1024 * 1024;

/** fs_read_chunk 의 요청 상한과 같은 값. */
export const IMAGE_CHUNK_BYTES = 4 * 1024 * 1024;

const LIMIT_MESSAGE = "Image file exceeds the 64 MiB limit";
const DECODE_MESSAGE = "Cannot decode image";

type ImageMode = "fit" | "original";

export class ImageView implements ViewerView {
  readonly root: HTMLDivElement;
  private readonly statusEl: HTMLDivElement;
  private readonly scrollEl: HTMLDivElement;
  private readonly toggleEl: HTMLButtonElement;
  private readonly imageEl: HTMLImageElement;
  private readonly modeEl: HTMLSpanElement;

  private path: string;
  private disposed = false;
  private loadToken = 0;
  private objectUrl: string | null = null;
  // 읽는 중인 청크. 지역 변수로 두면 dispose 뒤에도 진행 중인 읽기 요청이 끝날 때까지
  // 붙들린다 — release 가 바로 놓을 수 있게 뷰가 갖는다.
  private parts: Uint8Array<ArrayBuffer>[] = [];
  private loaded = false;
  private mode: ImageMode = "fit";

  constructor(
    parent: HTMLElement,
    private readonly distro: string | null,
    kind: ViewerKind,
  ) {
    this.path = kind.type === "imageViewer" ? kind.path : "";

    this.root = document.createElement("div");
    this.root.className = "image-view";

    this.statusEl = document.createElement("div");
    this.statusEl.className = "image-status";
    this.statusEl.hidden = true;

    this.scrollEl = document.createElement("div");
    this.scrollEl.className = "image-scroll";
    // 프로그램적 포커스와 원본 모드의 방향키 스크롤을 허용하되 Tab 순서에는
    // 넣지 않는다 (text/folder 뷰어와 같은 관례).
    this.scrollEl.tabIndex = -1;

    this.toggleEl = document.createElement("button");
    this.toggleEl.type = "button";
    this.toggleEl.className = "image-toggle";
    this.toggleEl.disabled = true;
    this.toggleEl.addEventListener("click", () => this.toggleMode());

    this.imageEl = document.createElement("img");
    this.imageEl.className = "image-canvas";
    this.imageEl.alt = "";
    this.toggleEl.append(this.imageEl);

    this.modeEl = document.createElement("span");
    this.modeEl.className = "image-mode";

    const barEl = document.createElement("div");
    barEl.className = "image-bar";
    barEl.append(this.modeEl);

    this.scrollEl.append(this.toggleEl);
    this.root.append(this.statusEl, this.scrollEl, barEl);
    parent.appendChild(this.root);

    this.setMode("fit");
    this.load();
  }

  update(kind: ViewerKind): void {
    if (kind.type !== "imageViewer") {
      // 탭의 kind 종류는 생성 후 바뀌지 않는다 — 오면 레지스트리 배선 결함이다.
      console.error("[mast] image view received a non-imageViewer kind", kind);
      return;
    }
    if (kind.path === this.path) return;
    this.path = kind.path;
    this.load();
  }

  /** 이미지 탭은 모델에 스크롤 위치가 없다 (setViewerScroll 대상이 되면
   *  kindMismatch) — dispatch 할 것이 없어 no-op 이다. */
  flushScroll(): void {}

  focus(): void {
    this.scrollEl.focus();
  }

  dispose(): void {
    this.disposed = true;
    this.loadToken += 1;
    this.release();
    this.root.remove();
  }

  private isStale(token: number): boolean {
    return this.disposed || token !== this.loadToken;
  }

  private load(): void {
    const token = ++this.loadToken;
    this.release();
    setBanner(this.statusEl, "loading…", false);
    this.read(token).catch((err: unknown) => {
      if (this.isStale(token)) return;
      this.fail(`cannot read ${this.path}: ${String(err)}`);
    });
  }

  private async read(token: number): Promise<void> {
    const stat = await fsStat(this.distro, this.path);
    if (this.isStale(token)) return;
    if (stat.is_dir) {
      this.fail(`cannot read ${this.path}: it is a directory`);
      return;
    }
    if (stat.size > IMAGE_MAX_BYTES) {
      this.fail(LIMIT_MESSAGE);
      return;
    }

    let offset = 0;
    let total = 0;
    for (;;) {
      const chunk = await fsReadChunk(this.distro, this.path, offset, IMAGE_CHUNK_BYTES);
      if (this.isStale(token)) return;
      const bytes = new Uint8Array(chunk);
      if (bytes.length === 0) break;
      total += bytes.length;
      if (total > IMAGE_MAX_BYTES) {
        this.fail(LIMIT_MESSAGE);
        return;
      }
      this.parts.push(bytes);
      offset += bytes.length;
      // 짧은 응답은 EOF 다 — 다음 요청을 보내지 않는다.
      if (bytes.length < IMAGE_CHUNK_BYTES) break;
    }

    const mime = imageMimeType(this.path);
    const blob = mime === null ? new Blob(this.parts) : new Blob(this.parts, { type: mime });
    this.parts = [];
    const url = URL.createObjectURL(blob);
    this.objectUrl = url;
    this.imageEl.onload = () => {
      if (this.isStale(token)) return;
      this.onLoaded();
    };
    this.imageEl.onerror = () => {
      if (this.isStale(token)) return;
      this.fail(DECODE_MESSAGE);
    };
    this.imageEl.src = url;
  }

  private onLoaded(): void {
    this.imageEl.onload = null;
    this.imageEl.onerror = null;
    this.loaded = true;
    this.toggleEl.disabled = false;
    setBanner(this.statusEl, null, false);
    this.setMode("fit");
  }

  private toggleMode(): void {
    if (!this.loaded) return;
    this.setMode(this.mode === "fit" ? "original" : "fit");
  }

  private setMode(mode: ImageMode): void {
    this.mode = mode;
    this.root.classList.toggle("original", mode === "original");
    this.modeEl.textContent = mode === "fit" ? "Fit" : "Original";
    const label = mode === "fit" ? "Show at original size" : "Fit image to pane";
    this.toggleEl.title = label;
    this.toggleEl.setAttribute("aria-label", label);
    // 모드가 바뀌면 스크롤은 원점으로 돌아간다.
    this.scrollEl.scrollTop = 0;
    this.scrollEl.scrollLeft = 0;
  }

  /** URL·src·읽던 청크·로드 대기·맞춤 상태를 놓는다. 이후 도착한 load/error 는
   *  토큰이 아니라 핸들러 제거로도 무시된다. */
  private release(): void {
    this.parts = [];
    this.loaded = false;
    this.toggleEl.disabled = true;
    this.imageEl.onload = null;
    this.imageEl.onerror = null;
    this.imageEl.removeAttribute("src");
    if (this.objectUrl !== null) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
    this.setMode("fit");
  }

  private fail(message: string): void {
    this.release();
    setBanner(this.statusEl, message, true);
  }
}
