// folderBrowser 탭의 뷰 — fs_list_dir 로 읽은 항목을 dirs-first 로 나열하고,
// 디렉터리 클릭은 NavigateFolder, 파일 클릭은 뷰어 탭 생성(확장자에 따라
// markdownViewer 또는 textViewer)으로 잇는다.
//
// 탐색이 뷰 내부 상태가 아니라 **dispatcher 명령**인 것이 이 파일의 핵심 계약이다
// (계획 v2 4장): 현재 경로는 모델(TabKind::FolderBrowser.path)이 소유하고,
// 뷰는 스냅샷이 내려준 kind 를 그릴 뿐이다. 그래서 앱을 재시작해도
// 경로가 복원되고(persist), 어떤 탐색이든 revision 을 남긴다. 파일 **내용** 읽기
// (fs_*)만 attach_terminal 류 콘텐츠 플레인 직접 invoke 다.
//
// 키보드만으로도 탐색이 된다 (체크포인트 2 UX): 리스트 컨테이너가 focus 를 갖고
// 선택 행 1개를 유지하며, 방향키·Home/End·PageUp/PageDown 이 선택을 옮기고
// Enter 가 클릭과 같은 라우팅을, Backspace 가 `..` 와 같은 상위 이동을 한다.
// 이 keydown 은 **뷰 내부 리스너**라 전역 가로채기(shared/keys.ts 의 window capture)와
// 층이 다르고, 수식키 없는 키만 소비하므로 Alt+Shift+방향키(전역 pane 이동)와 겹치지
// 않는다.
//
// 행 모델(folderRows)·정렬(sortEntries)·부모 경로(parentPath)·확장자 라우팅
// (viewerTabForPath)·선택 이동(moveSelection)·키 판정(folderKeyAction)은 DOM
// 무의존 순수 함수로 분리해 vitest 로 잠근다 — 이 파일에서 DOM 을 만지는 부분은
// 그 결과를 그대로 그리는 얇은 층이다.

import { fsListDir } from "../../../infrastructure/backend";
import type { DirEntry, DirListing } from "../../../infrastructure/backend";
import type { KeySpec } from "../../../shared/keys";
import { IS_MAC } from "../../../shared/platform";
import type { ViewerKind, ViewerView } from "../viewer-view";
import type { Command, CommandOutput, NewTab, PaneId, TabId } from "../../../shared/types";

/** UI 발 dispatch — main.ts dispatchUI 래퍼 (실패는 상태 라인에 표면화되고 null). */
type DispatchFn = (cmd: Command) => Promise<CommandOutput | null>;

/** path 는 그 행이 가리키는 **절대 경로**(부모 행 포함)이고, parent 는 `..` 행
 *  표시다. */
export interface FolderRow {
  label: string;
  path: string;
  isDir: boolean;
  size: number | null;
  parent: boolean;
}

/** 부모 디렉터리 경로 — 루트("/")면 null. 빈 세그먼트(`//`·후행 `/`)는 무시한다
 *  (코어 wslpath 의 정규화 규칙과 같은 취급). `..` 를 경로에 넣지 않고 여기서
 *  잘라내는 이유: 코어 validate_linux_path 가 `..` 컴포넌트를 거부한다. */
export function parentPath(path: string): string | null {
  const parts = path.split("/").filter((p) => p.length > 0);
  if (parts.length === 0) return null;
  parts.pop();
  return `/${parts.join("/")}`;
}

export function joinPath(dir: string, name: string): string {
  return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
}

/** dirs-first · name asc 정렬 (순수 — 백엔드는 fs 순서 그대로 준다).
 *
 *  localeCompare 는 쓰지 않는다: WebView 의 ICU 로케일에 따라 결과가 달라져
 *  테스트로 고정할 수 없다. 대소문자 무시 비교를 먼저 하고(사람이 기대하는
 *  순서), 같으면 코드포인트 순으로 안정적인 tiebreak 을 둔다. */
export function sortEntries(entries: readonly DirEntry[]): DirEntry[] {
  return [...entries].sort((a, b) => {
    if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
    const la = a.name.toLowerCase();
    const lb = b.name.toLowerCase();
    if (la !== lb) return la < lb ? -1 : 1;
    if (a.name !== b.name) return a.name < b.name ? -1 : 1;
    return 0;
  });
}

/** 루트가 아니면 맨 앞에 `..` 행이 붙는다. */
export function folderRows(path: string, entries: readonly DirEntry[]): FolderRow[] {
  const rows: FolderRow[] = [];
  const parent = parentPath(path);
  if (parent !== null) {
    rows.push({ label: "..", path: parent, isDir: true, size: null, parent: true });
  }
  for (const entry of sortEntries(entries)) {
    rows.push({
      label: entry.is_dir ? `${entry.name}/` : entry.name,
      path: joinPath(path, entry.name),
      isDir: entry.is_dir,
      size: entry.is_dir ? null : entry.size,
      parent: false,
    });
  }
  return rows;
}

/** 파일 클릭이 만드는 뷰어 탭 명세 (순수).
 *
 *  `.md`/`.markdown` 만 markdownViewer 로, 나머지는 전부 textViewer 로 연다.
 *  확장자는 **basename 의 마지막 점 뒤**로 본다: 선두 점은 dotfile 표시이지
 *  확장자가 아니므로 `.md` 라는 이름의 파일은 텍스트로 연다. */
export function viewerTabForPath(path: string): NewTab {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot) : "";
  return ext === ".md" || ext === ".markdown"
    ? { type: "markdownViewer", path }
    : { type: "textViewer", path };
}

/** 파일 크기 표시 (1024 진법, 정수는 소수점 없이). null 이면 빈 문자열. */
export function formatSize(size: number | null): string {
  if (size === null) return "";
  const units = ["B", "K", "M", "G", "T"];
  let value = size;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const text = unit === 0 ? String(value) : value.toFixed(value < 10 ? 1 : 0);
  return `${text}${units[unit]}`;
}

/** 키보드가 만드는 선택 이동 (Enter·Backspace 는 이동이 아니라 액션이라 별도). */
export type SelectionMove = "up" | "down" | "home" | "end" | "pageUp" | "pageDown";

/** PageUp/PageDown 한 번이 건너뛰는 행 수. viewport 높이를 재지 않고 고정값을
 *  쓴다 — 목록이 가상 스크롤이 아니라 실 DOM 이고, 행 높이·pane 크기에 따라
 *  이동량이 달라지면 순수 함수로 잠글 수 없다. */
export const PAGE_ROWS = 10;

/** 선택 이동 (순수). 결과는 항상 `[0, count)` 로 클램프되고, 끝에서 순환하지
 *  않는다 (목록 끝은 끝이다 — 연타로 되감기는 동작은 파일 목록에서 방향 감각을
 *  잃게 한다). 빈 목록은 선택 없음(-1)이고, 선택 없음 상태에서의 첫 이동은
 *  첫 행을 고른다 (End 만 마지막 행). */
export function moveSelection(index: number, count: number, move: SelectionMove): number {
  if (count <= 0) return -1;
  if (index < 0) return move === "end" ? count - 1 : 0;
  const clamp = (i: number): number => Math.min(Math.max(i, 0), count - 1);
  const from = clamp(index);
  switch (move) {
    case "up":
      return clamp(from - 1);
    case "down":
      return clamp(from + 1);
    case "home":
      return 0;
    case "end":
      return count - 1;
    case "pageUp":
      return clamp(from - PAGE_ROWS);
    case "pageDown":
      return clamp(from + PAGE_ROWS);
  }
}

/** 폴더 뷰 안에서 소비하는 keydown 의 뜻. `open` 은 선택 행을 클릭한 것과 같고
 *  (디렉터리 → 탐색, 파일 → 뷰어 탭), `parent` 는 `..` 행과 같다. */
export type FolderKeyAction =
  | { type: "move"; move: SelectionMove }
  | { type: "open" }
  | { type: "child" }
  | { type: "parent" };

const MOVE_KEYS: Record<string, SelectionMove | undefined> = {
  ArrowUp: "up",
  ArrowDown: "down",
  Home: "home",
  End: "end",
  PageUp: "pageUp",
  PageDown: "pageDown",
};

/** keydown → 폴더 뷰 액션. 목록 밖 조합은 전부 null 이고, 그때 뷰는 이벤트에
 *  손대지 않는다.
 *
 *  **수식키가 하나라도 붙으면 받지 않는다**: Alt+Shift+방향키는 전역 pane 이동
 *  (shared/keys.ts)이고 Ctrl 계열도 전역 목록 소유라, 여기서 같은 키를 소비하면 뷰어
 *  탭에서만 전역 이동이 죽는 비일관이 생긴다. IME 조합 중의 키도 조합기 몫이다
 *  (keys.keyAction 과 같은 규약). */
export function folderKeyAction(spec: KeySpec, mac = IS_MAC): FolderKeyAction | null {
  if (spec.isComposing) return null;
  if (spec.ctrl || spec.alt || spec.shift) return null;
  // macOS 는 Finder 관례를 따른다: ⌘↑ 상위 폴더, ⌘↓ 열기. 그 밖의 ⌘ 조합은 받지 않는다
  // (⌘←/→ 가 수식 없는 ←/→ 로 읽혀 폴더를 옮기지 않게). Windows 는 meta 를 보지 않는다.
  if (mac && spec.meta === true) {
    if (spec.key === "ArrowUp") return { type: "parent" };
    if (spec.key === "ArrowDown") return { type: "open" };
    return null;
  }
  const move = MOVE_KEYS[spec.key];
  if (move !== undefined) return { type: "move", move };
  if (spec.key === "Enter") return { type: "open" };
  if (spec.key === "ArrowRight") return { type: "child" };
  if (spec.key === "Backspace" || spec.key === "ArrowLeft") return { type: "parent" };
  return null;
}

/** 로드 실패 payload 의 표시 문자열 — 글루는 `Result<_, String>` 이라 문자열이
 *  오지만, IPC 레벨 실패 등 계약 밖 값도 삼키지 않는다. */
function describeError(err: unknown): string {
  return typeof err === "string" ? err : String(err);
}

export class FolderView implements ViewerView {
  readonly root: HTMLDivElement;
  private readonly bannerEl: HTMLDivElement;
  private readonly listEl: HTMLDivElement;
  private path: string;
  private disposed = false;
  /** in-flight 로드 토큰 — 늦게 도착한 이전 경로의 응답이 현재 목록을 덮지
   *  않게 한다 (탐색을 빠르게 연타하면 순서가 뒤집힐 수 있다). */
  private loadToken = 0;
  /** 지금 그려진 행 모델과 그 DOM — 인덱스가 1:1 로 대응한다 (키보드 선택이
   *  인덱스로 오가므로 둘을 같이 들고 있는다). */
  private rows: FolderRow[] = [];
  private rowEls: HTMLButtonElement[] = [];
  /** 빈 목록이면 -1. */
  private selected = -1;

  constructor(
    parent: HTMLElement,
    private readonly tab: TabId,
    /** 파일 클릭으로 만드는 textViewer 탭이 들어갈 pane — 같은 pane 이다
     *  (CreateTab 시맨틱상 새 탭이 곧바로 active 가 된다). */
    private readonly pane: PaneId,
    /** 워크스페이스 distro (없으면 null — 글루가 MAST_DISTRO·기본 배포판 순으로
     *  해석한다). 워크스페이스 생성 후 바뀌지 않는 값이라 생성 시 고정한다. */
    private readonly distro: string | null,
    kind: ViewerKind,
    private readonly dispatch: DispatchFn,
  ) {
    this.path = kind.type === "folderBrowser" ? kind.path : "/";

    this.root = document.createElement("div");
    this.root.className = "folder-view";

    this.bannerEl = document.createElement("div");
    this.bannerEl.className = "folder-banner";
    this.bannerEl.hidden = true;

    this.listEl = document.createElement("div");
    this.listEl.className = "folder-list";
    // 스크롤 컨테이너 자체를 focus 대상으로 둔다 (text/markdown 뷰어와 같은
    // 관례) — 여기가 프로그램적 focus 대상이자 키보드 탐색의 주인이다.
    // Tab 순서에는 넣지 않는다.
    this.listEl.tabIndex = -1;

    // 리스너는 root 에 둔다 — focus 가 리스트에 있든 행 버튼(마우스 클릭 직후)에
    // 있든 같은 경로로 올라온다.
    this.root.addEventListener("keydown", (ev) => this.onKeyDown(ev));

    this.root.append(this.bannerEl, this.listEl);
    parent.appendChild(this.root);

    this.load();
  }

  /** 무변경 렌더마다 재목록하면 매 revision 이 9P 왕복이 되므로, 경로가 바뀐
   *  경우(NavigateFolder)만 다시 읽는다. */
  update(kind: ViewerKind): void {
    if (kind.type !== "folderBrowser") {
      // 탭의 kind 종류는 생성 후 바뀌지 않는다 — 오면 레지스트리 배선 결함이다.
      console.error("[mast] folder view received a non-folderBrowser kind", kind);
      return;
    }
    if (kind.path === this.path) return;
    this.path = kind.path;
    this.load();
  }

  /** folderBrowser 는 모델에 스크롤 위치가 없다 (setViewerScroll 대상이 되면
   *  kindMismatch) — 기록할 것이 없어 no-op 이다. */
  flushScroll(): void {}

  focus(): void {
    this.listEl.focus();
  }

  dispose(): void {
    this.disposed = true;
    this.root.remove();
  }

  private load(): void {
    const token = ++this.loadToken;
    this.setBanner("loading…", false);
    // 로드 중에도 이전 목록을 그대로 둔다 — 깜빡임 없이 배너만 바뀐다.
    fsListDir(this.distro, this.path).then(
      (listing) => {
        if (this.disposed || token !== this.loadToken) return;
        this.renderListing(listing);
      },
      (err: unknown) => {
        if (this.disposed || token !== this.loadToken) return;
        this.renderError(err);
      },
    );
  }

  private renderListing(listing: DirListing): void {
    this.setBanner(
      listing.truncated
        ? `showing the first ${listing.entries.length} entries — this directory was truncated`
        : null,
      false,
    );
    this.renderRows(folderRows(this.path, listing.entries));
  }

  /** 로드 실패는 인라인 에러다 — 탭을 닫거나 경로를 되돌리지 않는다 (없는 경로도
   *  모델에 남아 재시도·수정이 가능해야 한다). 막다른 길이 되지 않게 `..` 행은
   *  남긴다. */
  private renderError(err: unknown): void {
    this.setBanner(`cannot list ${this.path}: ${describeError(err)}`, true);
    this.renderRows(folderRows(this.path, []));
  }

  private setBanner(text: string | null, error: boolean): void {
    this.bannerEl.textContent = text ?? "";
    this.bannerEl.hidden = text === null;
    this.bannerEl.classList.toggle("error", error);
  }

  /** 목록 교체 — 선택은 **항상 첫 행으로 리셋**한다. 목록이 갈리면(탐색·재로드)
   *  이전 인덱스는 다른 디렉터리의 엉뚱한 행을 가리키므로 보존할 의미가 없다. */
  private renderRows(rows: FolderRow[]): void {
    // 방금 지울 행 버튼이 focus 를 쥐고 있었으면(마우스로 디렉터리를 연 직후)
    // 노드가 사라지며 focus 가 body 로 떨어져 키보드 탐색이 끊긴다 — 리스트
    // 컨테이너로 되돌린다. 뷰 밖에 focus 가 있으면 건드리지 않는다.
    const hadFocus = this.root.contains(document.activeElement);
    this.rows = rows;
    this.rowEls = rows.map((row, index) => this.rowButton(row, index));
    this.selected = -1;
    this.listEl.replaceChildren(...this.rowEls);
    // 초기 선택은 `..` 를 건너뛴 첫 실제 행이다: `..` 를 집으면
    // "Enter 로 진입 → 곧바로 Enter" 가 하위 탐색이 아니라 부모로 되튀는 동작이
    // 된다. 실제 행이 없으면(빈 디렉터리) `..` 라도 집는다 — 나갈 길은 남긴다.
    const firstReal = rows.findIndex((row) => !row.parent);
    this.select(firstReal >= 0 ? firstReal : rows.length > 0 ? 0 : -1, false);
    if (hadFocus) this.listEl.focus();
  }

  /** scroll 이면 선택 행이 보이는 범위 밖으로 나가지 않을 만큼만 스크롤한다
   *  (block: "nearest" — 목록을 매번 가운데로 튀게 하지 않는다). */
  private select(index: number, scroll: boolean): void {
    const prev = this.selected;
    if (prev >= 0 && prev < this.rowEls.length) this.rowEls[prev].classList.remove("selected");
    this.selected = index;
    if (index < 0 || index >= this.rowEls.length) return;
    const el = this.rowEls[index];
    el.classList.add("selected");
    if (scroll) el.scrollIntoView({ block: "nearest" });
  }

  /** preventDefault 는 두 가지를 막는다: 방향키·PageUp/Down 의 컨테이너 기본
   *  스크롤(선택의 scrollIntoView 와 이중으로 움직인다)과, 행 버튼이 focus 를
   *  쥔 상태(마우스 클릭 직후)에서 Enter 가 네이티브 click 까지 발화시켜 같은
   *  행을 두 번 여는 것. */
  private onKeyDown(ev: KeyboardEvent): void {
    const action = folderKeyAction({
      key: ev.key,
      ctrl: ev.ctrlKey,
      meta: ev.metaKey,
      alt: ev.altKey,
      shift: ev.shiftKey,
      isComposing: ev.isComposing,
    });
    if (action === null) return;
    ev.preventDefault();
    switch (action.type) {
      case "move":
        this.select(moveSelection(this.selected, this.rows.length, action.move), true);
        return;
      case "open":
        if (this.selected >= 0 && this.selected < this.rows.length) {
          this.openRow(this.rows[this.selected]);
        }
        return;
      case "child": {
        const row = this.rows[this.selected];
        if (row?.isDir && !row.parent) this.openRow(row);
        return;
      }
      case "parent":
        this.navigateParent();
        return;
    }
  }

  /** Backspace — `..` 행과 같은 상위 이동. 루트에서는 조용한 no-op 이다
   *  (parentPath 가 null: 이동 계열은 에러를 띄우지 않는다). */
  private navigateParent(): void {
    const parent = parentPath(this.path);
    if (parent === null) return;
    void this.dispatch({ type: "navigateFolder", tab: this.tab, path: parent });
  }

  private rowButton(row: FolderRow, index: number): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = row.isDir ? "folder-row dir" : "folder-row";

    const name = document.createElement("span");
    name.className = "folder-row-name";
    name.textContent = row.label;
    name.title = row.path;

    const size = document.createElement("span");
    size.className = "folder-row-size";
    size.textContent = formatSize(row.size);

    btn.append(name, size);
    btn.addEventListener("click", () => {
      // 클릭한 행으로 선택을 옮긴 뒤 연다 — 클릭이 하는 일은 그대로고, 뒤이은
      // Enter 가 엉뚱한 행(직전 선택)을 열지 않게 두 입력의 "현재 행"을 하나로
      // 맞춘다. 스크롤은 하지 않는다 (이미 눈에 보이는 행이다).
      this.select(index, false);
      this.openRow(row);
    });
    return btn;
  }

  /** 디렉터리는 탐색(모델 경유), 파일은 같은 pane 에 뷰어 탭 생성 — 확장자로
   *  markdownViewer / textViewer 를 고른다 (viewerTabForPath). 클릭과 Enter 가
   *  같은 경로다. 실패(없는 경로·kindMismatch 등)는 dispatchUI 가 상태 라인에
   *  표면화한다. */
  private openRow(row: FolderRow): void {
    if (row.isDir) {
      void this.dispatch({ type: "navigateFolder", tab: this.tab, path: row.path });
      return;
    }
    void this.dispatch({
      type: "createTab",
      pane: this.pane,
      tab: viewerTabForPath(row.path),
    });
  }
}
