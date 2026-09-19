// 워크스페이스를 떠난 터미널 탭의 스크롤 위치 기억 (ADR-0019 결정 3) — DOM·IPC
// 무의존이라 vitest 가 정책을 잠근다. 소유자는 workspace-view 의 리컨실이고,
// 값은 TerminalView 가 dispose 직전에 읽어 준 "하단으로부터의 줄 수"다.
//
// 수명은 **페이지 세션**이다 (ADR-0019 개정 2026-09-20). 위치를 sessionStorage
// 에도 남긴다: 리셋 supervisor 의 자동 리로드(hidden 600s·워크스페이스 전환의
// 대기 워치독)와 Ctrl+Shift+R 은 JS 컨텍스트를 통째로 버리므로, 메모리만으로는
// 리로드 순간 살아 있던 탭의 위치가 함께 사라진다. sessionStorage 는 페이지
// 세션 — 리로드는 넘기고 WebView(=앱) 종료는 넘기지 못한다 — 에 묶여 있어
// "같은 WebView 수명"이라는 옛 경계를 유지한 채 리로드만 메운다.
//
// 값의 유효성은 탭 id 가 아니라 (탭 id, PTY 세션 id) 쌍으로 판정한다: respawn 으로
// 세션이 바뀐 탭에 옛 화면의 위치를 적용하면 무관한 셸의 스크롤이 되고, 저장소가
// 앱 재시작을 넘겨 살아남는 플랫폼에서도 같은 오적용이 난다.

import type { SessionId, TabId } from "../../shared/types";

/** 저장 키 — 값은 아래 StoredFile JSON 하나다 (탭 수만큼 키를 만들지 않는다). */
export const SCROLL_MEMORY_KEY = "mast:scroll-memory";

/** sessionStorage 의 부분집합 — 테스트가 가짜 저장소를 끼울 수 있게 좁혀 둔다. */
export interface ScrollMemoryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface ScrollMemoryEntry {
  session: SessionId;
  offset: number;
}

interface StoredFile {
  version: 1;
  entries: Record<string, ScrollMemoryEntry>;
}

/** sessionStorage 접근 자체가 막힌 환경(프라이버시 설정 등)은 null 로 물러난다 —
 *  리로드 기억 없이 메모리만으로 동작하고, 그 사실은 한 번 loud 하게 남긴다.
 *  DOM 이 아예 없는 실행(단위 테스트)은 실패가 아니라 전제 밖이라 조용히 null 이다. */
function defaultStorage(): ScrollMemoryStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch (err) {
    console.warn("[mast] sessionStorage unavailable; a webview reload will not keep scroll positions", err);
    return null;
  }
}

/** 저장 파일에서 꺼낸 값의 형태 검사 — 리로드를 넘어온 JSON 은 신뢰 경계 밖이다. */
function isEntry(value: unknown): value is ScrollMemoryEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as { session?: unknown; offset?: unknown };
  return (
    typeof entry.session === "number" &&
    Number.isInteger(entry.session) &&
    typeof entry.offset === "number" &&
    Number.isInteger(entry.offset) &&
    entry.offset > 0
  );
}

export class ScrollMemory {
  private readonly offsets = new Map<TabId, ScrollMemoryEntry>();
  /** 저장소가 던진 뒤 — 이후 쓰기를 시도하지 않고 이번 수명은 메모리만 쓴다. */
  private storageBroken = false;

  constructor(private readonly storage: ScrollMemoryStorage | null = defaultStorage()) {
    this.load();
  }

  /** 워크스페이스 이탈로 dispose 되는 탭의 위치를 남긴다. 닫힌 탭은 돌아올
   *  자리가 없으므로 호출자가 걸러서 부른다 (실존 판정은 스냅샷의 몫). */
  remember(tab: TabId, session: SessionId, offset: number): void {
    this.offsets.set(tab, { session, offset });
    this.writeThrough();
  }

  /** 1회성 인출 — 꺼내는 즉시 지운다. 복원이 취소되거나 attach 가 실패해도 낡은
   *  위치가 다음 attach 에 다시 적용되지 않게 하는 것이 이 일회성의 이유다.
   *  세션이 다르면 돌려주지 않는다 (respawn·앱 재시작의 낡은 값). */
  take(tab: TabId, session: SessionId): number | undefined {
    const entry = this.offsets.get(tab);
    if (entry === undefined) return undefined;
    this.offsets.delete(tab);
    this.writeThrough();
    return entry.session === session ? entry.offset : undefined;
  }

  /** 스냅샷에 없는 탭의 기억을 걷는다. 비활성 워크스페이스에서 닫힌 탭은 dispose
   *  루프를 타지 않아 여기서만 정리된다 — 그 경로가 없으면 기억이 샌다. */
  prune(existing: Set<TabId>): void {
    let removed = false;
    for (const tab of this.offsets.keys()) {
      if (!existing.has(tab)) {
        this.offsets.delete(tab);
        removed = true;
      }
    }
    if (removed) this.writeThrough();
  }

  /** 이전 페이지(리로드 전)가 남긴 저장 파일을 읽는다. 손상·미지원 형식은 통째로
   *  버린다 — 일부만 살리면 어느 탭의 값인지 믿을 수 없다. */
  private load(): void {
    const raw = this.read();
    if (raw === null) return;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
      const file = parsed as { version?: unknown; entries?: unknown };
      if (
        file.version !== 1 ||
        typeof file.entries !== "object" ||
        file.entries === null
      ) {
        throw new Error("unsupported shape");
      }
      for (const [key, value] of Object.entries(file.entries as Record<string, unknown>)) {
        const tab = Number(key);
        if (!Number.isInteger(tab) || tab < 0 || !isEntry(value)) continue;
        this.offsets.set(tab, value);
      }
    } catch (err) {
      console.warn("[mast] scroll memory file unreadable; starting empty", err);
      this.clearStorage();
    }
  }

  private read(): string | null {
    if (this.storage === null || this.storageBroken) return null;
    try {
      return this.storage.getItem(SCROLL_MEMORY_KEY);
    } catch (err) {
      this.storageBroken = true;
      console.warn("[mast] scroll memory storage unreadable; keeping positions for this page only", err);
      return null;
    }
  }

  private writeThrough(): void {
    if (this.storage === null || this.storageBroken) return;
    // 마지막 값이 빠지면 키 자체를 걷는다 — 빈 파일을 남기면 다음 리로드가
    // "기억은 있는데 값이 없는" 상태를 굳이 읽는다.
    if (this.offsets.size === 0) {
      this.clearStorage();
      return;
    }
    const entries: Record<string, ScrollMemoryEntry> = {};
    for (const [tab, entry] of this.offsets) entries[String(tab)] = entry;
    const file: StoredFile = { version: 1, entries };
    try {
      this.storage.setItem(SCROLL_MEMORY_KEY, JSON.stringify(file));
    } catch (err) {
      this.storageBroken = true;
      console.warn("[mast] scroll memory storage write failed; a webview reload will not keep scroll positions", err);
    }
  }

  private clearStorage(): void {
    if (this.storage === null || this.storageBroken) return;
    try {
      this.storage.removeItem(SCROLL_MEMORY_KEY);
    } catch (err) {
      this.storageBroken = true;
      console.warn("[mast] scroll memory storage cleanup failed", err);
    }
  }
}
