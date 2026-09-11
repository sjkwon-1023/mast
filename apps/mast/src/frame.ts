// 채널 프레임 `[u64 LE offset][bytes]` 파서 — I/O 없는 순수 함수 (vitest 대상).
// attach_terminal 응답은 `[u64 LE end_offset][u8 first_attach][replay bytes]` 로
// 플래그 1바이트가 추가된 별도 형식이다 (parseAttachBody — 체크포인트 1 재시작
// 빈 화면 버그 수정: 최초 attach 판정).

/** 파싱된 프레임. offset 은 chunk 시작 시점의 누적 스트림 오프셋
 *  (attach 응답에서는 스냅샷 끝 오프셋 end_offset). */
export interface Frame {
  offset: number;
  bytes: Uint8Array;
}

export const FRAME_HEADER_BYTES = 8;

/** `[u64 LE offset][bytes]` 를 파싱한다.
 *
 *  u64 → JS number 변환: Number.MAX_SAFE_INTEGER(2^53-1) 초과는 정밀도가
 *  깨지므로 명확히 throw 한다 — 세션 출력 누적이 9PB 를 넘는 경우라 실질
 *  도달 불가지만, 조용한 오프셋 왜곡(dedup 오판)보다 loud 실패가 낫다. */
export function parseFrame(data: ArrayBuffer | Uint8Array): Frame {
  const view = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (view.byteLength < FRAME_HEADER_BYTES) {
    throw new Error(
      `frame too short: ${view.byteLength} bytes (need >= ${FRAME_HEADER_BYTES}-byte u64 LE header)`,
    );
  }
  // Uint8Array 가 큰 버퍼의 부분 뷰일 수 있으므로 byteOffset 을 반영한다.
  const dv = new DataView(view.buffer, view.byteOffset, view.byteLength);
  const raw = dv.getBigUint64(0, true);
  if (raw > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`frame offset ${raw} exceeds Number.MAX_SAFE_INTEGER`);
  }
  return { offset: Number(raw), bytes: view.subarray(FRAME_HEADER_BYTES) };
}

/** attach_terminal 응답 `[u64 LE end_offset][u8 first_attach][replay bytes]`.
 *  `firstAttach` 가 true 면 replay 속 단말 질의는 아직 응답 안 된 라이브 질의라
 *  xterm 자동 응답을 허용해야 하고(억제 시 conhost 가 CPR 대기로 셸 정지 —
 *  체크포인트 1 재시작 빈 화면 버그), false 면 이미 응답된 낡은 질의라 억제해야
 *  한다 (stray `R` 버그). */
export interface AttachBody {
  endOffset: number;
  firstAttach: boolean;
  replay: Uint8Array;
}

export const ATTACH_HEADER_BYTES = 9;

export function parseAttachBody(data: ArrayBuffer | Uint8Array): AttachBody {
  const view = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (view.byteLength < ATTACH_HEADER_BYTES) {
    throw new Error(
      `attach body too short: ${view.byteLength} bytes (need >= ${ATTACH_HEADER_BYTES})`,
    );
  }
  const dv = new DataView(view.buffer, view.byteOffset, view.byteLength);
  const raw = dv.getBigUint64(0, true);
  if (raw > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`attach end_offset ${raw} exceeds Number.MAX_SAFE_INTEGER`);
  }
  return {
    endOffset: Number(raw),
    firstAttach: dv.getUint8(8) !== 0,
    replay: view.subarray(ATTACH_HEADER_BYTES),
  };
}
