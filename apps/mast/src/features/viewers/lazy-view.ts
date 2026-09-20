import type { ViewerKind, ViewerView } from "./viewer-view";

type ViewerFactory = (parent: HTMLElement, kind: ViewerKind) => ViewerView;

export class LazyViewerView implements ViewerView {
  private readonly placeholder = document.createElement("div");
  private view: ViewerView | null = null;
  private disposed = false;

  constructor(
    parent: HTMLElement,
    private kind: ViewerKind,
    load: () => Promise<ViewerFactory>,
  ) {
    this.placeholder.className = "pane-placeholder";
    this.placeholder.textContent = "loading…";
    this.placeholder.tabIndex = -1;
    parent.append(this.placeholder);
    void this.mount(parent, load);
  }

  get root(): HTMLElement {
    return this.view?.root ?? this.placeholder;
  }

  update(kind: ViewerKind): void {
    this.kind = kind;
    this.view?.update(kind);
  }

  flushScroll(): void {
    this.view?.flushScroll();
  }

  focus(): void {
    if (this.view !== null) this.view.focus();
    else this.placeholder.focus();
  }

  dispose(): void {
    this.disposed = true;
    this.view?.dispose();
    this.view = null;
    this.placeholder.remove();
  }

  private async mount(parent: HTMLElement, load: () => Promise<ViewerFactory>): Promise<void> {
    try {
      const create = await load();
      // import는 취소할 수 없으므로 탭이 닫혔으면 생성자와 파일 읽기를 시작하지 않는다.
      if (this.disposed) return;
      const focused = document.activeElement === this.placeholder;
      this.view = create(parent, this.kind);
      this.placeholder.remove();
      if (focused) this.view.focus();
    } catch (err) {
      if (this.disposed) return;
      console.error("viewer load failed", err);
      this.placeholder.textContent = `cannot load viewer: ${String(err)}`;
    }
  }
}
