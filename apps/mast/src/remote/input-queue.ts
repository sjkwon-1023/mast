// 입력 전송 FIFO — 폰이 보내는 모든 바이트가 여기를 지난다.
//
// 왜 큐가 필요한가. 요청 하나가 커넥션 하나이고 서버는 커넥션마다 스레드를
// 띄우므로, 두 POST 를 겹쳐 쏘면 PTY 에 도착하는 순서가 보장되지 않는다.
// 앞 요청의 응답을 받은 뒤 다음을 보내는 것이 순서를 지키는 유일한 방법이다.
//
// 왜 텍스트와 Enter 가 두 요청인가. 한 write 에 텍스트와 CR 을 같이 넣으면
// 붙여넣기를 감지하는 에이전트(Claude Code 의 chunk 길이 규칙, Codex 의 paste
// burst)가 CR 을 붙여넣기의 일부로 보고 줄바꿈으로 삼킨다 — 텍스트는 입력칸에
// 남고 아무것도 실행되지 않는다. `mast send` 에서 실측된 고장이고 v0.3.16 이
// 같은 방식(별개 write + 지연)으로 고쳤다.
//
// 실패하면 큐를 통째로 비우는 것도 그 때문이다: 텍스트가 안 들어갔는데 CR 만
// 도착하면 그 탭에서 직전 명령이 다시 실행된다.

/** 텍스트 응답 뒤 Enter 를 보내기까지의 최소 간격. */
export const ENTER_DELAY_MS = 150;

export interface InputItem {
  /** PTY 로 그대로 간다 (인코딩은 protocol.ts 가 끝냈다). */
  data: string;
  /** 앞 항목의 **응답이 온 뒤** 이만큼 기다렸다 보낸다. */
  delayBeforeMs?: number;
}

export interface InputQueueOptions {
  send: (data: string) => Promise<void>;
  /** 한 항목이 실패했다 — 남은 항목은 이미 버려진 상태로 호출된다. 어느
   *  항목이었는지를 같이 주는 이유는 호출자가 그 입력을 되살릴 수 있어야 하기
   *  때문이다 (폰에서 손으로 친 텍스트가 실패 한 번에 사라지면 안 된다). */
  onError: (error: unknown, item: InputItem) => void;
  /** 성공으로 큐가 비었을 때만 호출된다. 입력 컨트롤 잠금 해제에 쓴다. */
  onIdle?: () => void;
}

export class InputQueue {
  private readonly items: InputItem[] = [];
  private running = false;

  constructor(private readonly options: InputQueueOptions) {}

  /** 전송 중인 것은 이미 빠져 있다. */
  get pending(): number {
    return this.items.length;
  }

  get busy(): boolean {
    return this.running;
  }

  push(...items: InputItem[]): void {
    this.items.push(...items);
    void this.pump();
  }

  /** 뷰가 사라질 때 호출한다 — 전송 중인 것은 못 막는다. */
  clear(): void {
    this.items.length = 0;
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    while (this.items.length > 0) {
      const item = this.items.shift() as InputItem;
      if (item.delayBeforeMs !== undefined && item.delayBeforeMs > 0) {
        await delay(item.delayBeforeMs);
      }
      try {
        await this.options.send(item.data);
      } catch (error) {
        // 후속(대개 CR)을 보내면 안 된다 — 위 모듈 주석.
        this.items.length = 0;
        this.running = false;
        this.options.onError(error, item);
        return;
      }
    }
    this.running = false;
    this.options.onIdle?.();
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
