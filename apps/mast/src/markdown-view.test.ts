// markdownViewer 의 위험 지점 검증 (21단계 청크 D + v0.3.8 줌).
//
// 1. **raw HTML escape** — 이 WebView 는 dispatch·fs_* IPC 를 쥐고 있어서, 파일
//    내용발 HTML 이 DOM 에 들어가면 마크다운 파일 하나로 앱 권한이 넘어간다.
//    "renderer 를 이렇게 설정했다"가 아니라 **실제 렌더 출력**에 스크립트 태그·
//    이벤트 핸들러 속성·href 가 남지 않는지를 단언한다 (설정이 marked 버전
//    업그레이드로 무력화되면 여기서 깨져야 한다).
// 2. **폴링 상태기계** — 변화 감지·hidden 정지·dispose 정리. 타이머를 주입해
//    결정적으로 돌린다 (AckBatcher·ScrollSettle 전례).
// 3. **줌 앵커** (v0.3.8) — 글자 크기가 바뀌면 산문이 리플로우돼 이 뷰의 px
//    좌표가 무의미해진다. 줌 앞뒤를 잇는 상대 위치 계산이 그 유일한 다리다.
//
// DOM·IPC 는 이 파일의 대상이 아니다 (뷰는 이 결과를 그대로 그리는 얇은 층이다).
// 앵커도 계산만 여기서 보고, 실제 리플로우 뒤 화면 위치는 레이아웃이 필요하므로
// Windows 수동 검증(§10 v0.3.8 item 3)이 맡는다 — happy-dom 은 scrollHeight 가
// 0 이라 이 경로를 재현하지 못한다.

import { describe, expect, it } from "vitest";

import {
  MtimePoller,
  renderMarkdown,
  scrollAnchorRatio,
  scrollTopForAnchor,
} from "./markdown-view";
import type { TimerHost } from "./ack-batcher";

/** 수동 진행 가짜 타이머 — 등록된 콜백을 fire 로 직접 발화시킨다
 *  (text-view.test.ts 와 같은 형태). */
class FakeTimers implements TimerHost {
  private next = 1;
  private readonly pending = new Map<number, { fn: () => void; ms: number }>();

  setTimeout(fn: () => void, ms: number): unknown {
    const handle = this.next++;
    this.pending.set(handle, { fn, ms });
    return handle;
  }

  clearTimeout(handle: unknown): void {
    this.pending.delete(handle as number);
  }

  get armed(): number {
    return this.pending.size;
  }

  /** 등록된 마지막 타이머의 지연(ms). */
  get lastDelay(): number | null {
    let delay: number | null = null;
    for (const entry of this.pending.values()) delay = entry.ms;
    return delay;
  }

  /** 보류 중인 콜백 전부 발화. */
  fire(): void {
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) entry.fn();
  }
}

/** 렌더 결과에 **실제 태그로** 등장하는 이름들 (이스케이프된 `&lt;script&gt;`
 *  는 여기 잡히지 않는다 — 그것이 escape 가 먹었다는 뜻이다). */
function tagNames(html: string): string[] {
  return [...html.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9-]*)/g)].map((m) => m[1].toLowerCase());
}

/** 태그 안에 이벤트 핸들러 속성(`onclick=` 등)이 있는가 — 이스케이프된 본문의
 *  같은 글자열에는 걸리지 않게 `<...>` 안쪽만 본다. */
function hasEventHandlerAttribute(html: string): boolean {
  return /<[^>]*\son[a-z]+\s*=/i.test(html);
}

describe("renderMarkdown", () => {
  it("renders ordinary markdown structure", () => {
    const html = renderMarkdown("# Title\n\nsome *emphasis* and `code`\n");
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<em>emphasis</em>");
    expect(html).toContain("<code>code</code>");
  });

  it("escapes a block-level script tag into visible text", () => {
    const html = renderMarkdown("<script>alert('x')</script>\n");
    expect(tagNames(html)).not.toContain("script");
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapes inline raw html including event-handler attributes", () => {
    const html = renderMarkdown("text <img src=x onerror=alert(1)> more\n");
    expect(tagNames(html)).not.toContain("img");
    // 문자열로는 남지만 태그 속성이 아니라 본문 텍스트다.
    expect(hasEventHandlerAttribute(html)).toBe(false);
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("escapes raw html inside tables and lists too", () => {
    const html = renderMarkdown(
      ["| a |", "| --- |", "| <i>x</i> |", "", "- <b>item</b>", ""].join("\n"),
    );
    expect(tagNames(html)).not.toContain("i");
    expect(tagNames(html)).not.toContain("b");
    expect(html).toContain("&lt;i&gt;x&lt;/i&gt;");
    expect(html).toContain("&lt;b&gt;item&lt;/b&gt;");
  });

  it("keeps html inside fenced code blocks as text", () => {
    const html = renderMarkdown("```html\n<script>boom()</script>\n```\n");
    expect(tagNames(html)).not.toContain("script");
    expect(html).toContain("&lt;script&gt;boom()&lt;/script&gt;");
  });

  it("emits only a known set of tags for a document full of raw html", () => {
    const html = renderMarkdown(
      [
        "# t <span>x</span>",
        "",
        "a paragraph with <iframe src=evil></iframe> inline",
        "",
        "<style>body{}</style>",
        "",
        "<a href=x>y</a>",
        "",
      ].join("\n"),
    );
    // 태그는 마크다운 구조가 만든 것뿐이다 — 파일에서 온 태그는 하나도 없다.
    expect([...new Set(tagNames(html))].sort()).toEqual(["h1", "p"]);
  });

  it("renders links without any href (click is a no-op, javascript: cannot survive)", () => {
    const html = renderMarkdown("[click](javascript:alert(1)) and <https://example.com>\n");
    // href 가 없으므로 앵커가 어디로도 가지 않는다 — 대상은 title 툴팁으로만
    // 남고, 그 값도 이스케이프된다.
    expect(html).not.toContain("href");
    expect(html).toContain('<a class="md-link" title="javascript:alert(1)">click</a>');
  });

  it("escapes quotes in a link target so the title attribute cannot be broken out of", () => {
    const html = renderMarkdown('[x](<a" onmouseover="alert(1)>)\n');
    expect(html).not.toContain('onmouseover="alert(1)"');
    expect(html).toContain("&quot;");
  });

  it("replaces images with placeholder text instead of loading anything", () => {
    const html = renderMarkdown("![alt text](https://example.com/pic.png)\n");
    expect(html).not.toContain("<img");
    expect(html).toContain('<span class="md-image">[image: alt text]</span>');
  });

  it("falls back to the image target when there is no alt text", () => {
    const html = renderMarkdown("![](pic.png)\n");
    expect(html).toContain('<span class="md-image">[image: pic.png]</span>');
  });
});

describe("MtimePoller", () => {
  interface Harness {
    poller: MtimePoller;
    timers: FakeTimers;
    changes: number[];
    setMtime: (value: number) => void;
    setHidden: (value: boolean) => void;
    /** stat 호출 횟수 — hidden 동안 폴링이 0 인지 확인한다. */
    stats: () => number;
  }

  function make(baseline = 1_000): Harness {
    const timers = new FakeTimers();
    const changes: number[] = [];
    let mtime = baseline;
    let hidden = false;
    let stats = 0;
    const poller = new MtimePoller(
      () => {
        stats += 1;
        return Promise.resolve(mtime);
      },
      (value) => changes.push(value),
      { intervalMs: 2_000, timers, isHidden: () => hidden },
    );
    return {
      poller,
      timers,
      changes,
      setMtime: (value) => {
        mtime = value;
      },
      setHidden: (value) => {
        hidden = value;
      },
      stats: () => stats,
    };
  }

  /** 타이머 발화 → tick 의 await 해소까지 한 주기를 진행시킨다. */
  async function cycle(h: Harness): Promise<void> {
    h.timers.fire();
    await Promise.resolve();
    await Promise.resolve();
  }

  it("arms a 2s timeout chain instead of an interval", async () => {
    const h = make();
    h.poller.start(1_000);
    expect(h.timers.armed).toBe(1);
    expect(h.timers.lastDelay).toBe(2_000);

    await cycle(h);
    // 한 주기의 stat 이 끝난 **뒤에** 다음 타이머를 건다 (겹침 없음).
    expect(h.stats()).toBe(1);
    expect(h.timers.armed).toBe(1);
  });

  it("fires onChanged once per mtime change and moves the baseline", async () => {
    const h = make();
    h.poller.start(1_000);

    await cycle(h);
    expect(h.changes).toEqual([]);

    h.setMtime(2_000);
    await cycle(h);
    expect(h.changes).toEqual([2_000]);

    // 같은 mtime 이 계속 관측돼도 다시 발화하지 않는다.
    await cycle(h);
    expect(h.changes).toEqual([2_000]);
  });

  it("stops polling while the document is hidden and resumes on sync", async () => {
    const h = make();
    h.poller.start(1_000);

    h.setHidden(true);
    h.poller.sync();
    expect(h.timers.armed).toBe(0);
    const before = h.stats();
    h.timers.fire();
    await Promise.resolve();
    expect(h.stats()).toBe(before); // 숨은 동안 9P 왕복 0

    // 변화가 있었어도 보이기 전에는 알아채지 않는다.
    h.setMtime(3_000);
    expect(h.changes).toEqual([]);

    h.setHidden(false);
    h.poller.sync();
    expect(h.timers.armed).toBe(1);
    await cycle(h);
    expect(h.changes).toEqual([3_000]);
  });

  it("does not arm at all when it starts while hidden", () => {
    const h = make();
    h.setHidden(true);
    h.poller.start(1_000);
    expect(h.timers.armed).toBe(0);
  });

  it("clears the timer on dispose and never fires again (no leak)", async () => {
    const h = make();
    h.poller.start(1_000);
    h.poller.dispose();
    expect(h.timers.armed).toBe(0);
    expect(h.poller.armed).toBe(false);

    // dispose 뒤의 start·sync 도 타이머를 되살리지 않는다.
    h.poller.start(1_000);
    h.poller.sync();
    expect(h.timers.armed).toBe(0);

    h.setMtime(4_000);
    h.timers.fire();
    await Promise.resolve();
    expect(h.changes).toEqual([]);
  });

  it("does not re-arm when dispose happens during an in-flight stat", async () => {
    const timers = new FakeTimers();
    const changes: number[] = [];
    let resolveStat: (value: number) => void = () => {};
    const poller = new MtimePoller(
      () =>
        new Promise<number>((resolve) => {
          resolveStat = resolve;
        }),
      (value) => changes.push(value),
      { intervalMs: 2_000, timers, isHidden: () => false },
    );
    poller.start(1_000);
    timers.fire(); // tick 진입 — stat 이 아직 미해소
    poller.dispose();
    resolveStat(9_999);
    await Promise.resolve();
    await Promise.resolve();
    expect(changes).toEqual([]);
    expect(timers.armed).toBe(0);
  });

  it("keeps polling after a failed stat (atomic saves make the file vanish briefly)", async () => {
    const timers = new FakeTimers();
    const changes: number[] = [];
    let fail = true;
    const poller = new MtimePoller(
      () => (fail ? Promise.reject(new Error("no such file")) : Promise.resolve(5_000)),
      (value) => changes.push(value),
      { intervalMs: 2_000, timers, isHidden: () => false },
    );
    poller.start(1_000);

    timers.fire();
    await Promise.resolve();
    await Promise.resolve();
    expect(changes).toEqual([]);
    expect(timers.armed).toBe(1); // 실패가 체인을 끊지 않는다

    fail = false;
    timers.fire();
    await Promise.resolve();
    await Promise.resolve();
    expect(changes).toEqual([5_000]);
  });

  it("stays quiet until start (a view that never loaded polls nothing)", () => {
    const h = make();
    h.poller.sync();
    expect(h.timers.armed).toBe(0);
  });

  it("re-baselines on every start without stacking timers (one load, one chain)", async () => {
    // 로드가 끝날 때마다 start 가 불린다 — 기준만 옮기고 체인은 하나로 유지한다.
    const h = make();
    h.poller.start(1_000);
    h.poller.start(1_000);
    h.poller.start(1_000);
    expect(h.timers.armed).toBe(1);

    h.setMtime(7_000);
    h.poller.start(7_000); // 새 내용이 화면에 앉은 시점의 기준
    await cycle(h);
    // 기준이 이미 7_000 이라 같은 값은 변화가 아니다.
    expect(h.changes).toEqual([]);
  });
});

// 줌 앵커 — 산문 리플로우를 건너 화면 위치를 잇는 유일한 좌표다. 이 뷰에는
// textViewer 의 행 인덱스 같은 안정 좌표가 없어서 상대 위치를 쓴다.
describe("줌 앵커", () => {
  it("문서 안 상대 위치를 붙든다", () => {
    // 스크롤 여지 = 2000 - 500 = 1500, 그 절반 지점.
    expect(scrollAnchorRatio(750, 2000, 500)).toBe(0.5);
    expect(scrollAnchorRatio(0, 2000, 500)).toBe(0);
    expect(scrollAnchorRatio(1500, 2000, 500)).toBe(1);
  });

  it("스크롤 여지가 없으면 0 이다 (되돌릴 것이 없다)", () => {
    expect(scrollAnchorRatio(0, 400, 500)).toBe(0);
    expect(scrollAnchorRatio(120, 500, 500)).toBe(0);
  });

  it("줌으로 문서가 커져도 같은 자리를 가리킨다", () => {
    // 12 → 14px 이면 높이가 대략 같은 비율로 늘어난다. px 를 그대로 두면
    // 750 이 여전히 750 이라 읽던 자리가 밀린다 — 비율은 따라 올라간다.
    const ratio = scrollAnchorRatio(750, 2000, 500);
    expect(scrollTopForAnchor(ratio, 2333, 500)).toBe(917);
    // 되돌아오면 원래 자리다 (정수 반올림 오차 안).
    expect(scrollTopForAnchor(ratio, 2000, 500)).toBe(750);
  });

  it("문서가 뷰포트보다 짧아지면 맨 위다", () => {
    expect(scrollTopForAnchor(1, 400, 500)).toBe(0);
  });

  it("범위 밖 입력은 경계에 멈춘다 (정수 px)", () => {
    expect(scrollTopForAnchor(2, 2000, 500)).toBe(1500);
    expect(scrollTopForAnchor(-1, 2000, 500)).toBe(0);
    expect(Number.isInteger(scrollTopForAnchor(1 / 3, 2000, 500))).toBe(true);
  });
});
