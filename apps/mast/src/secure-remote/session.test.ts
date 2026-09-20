import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RememberedSession } from "./session";
import { readRememberedPairing, rememberPairing, REMEMBERED_PAIRING_KEY, MAX_PAIRING_AGE_MS } from "./remembered";
import { parsePairingFragment } from "./pairing";
import { WebTransportClient } from "./transport";
import { RemoteError } from "../remote/transport";

const parsed = parsePairingFragment(`#v=1&host=192.168.0.20&port=7331&cert=${"A".repeat(43)}&token=${"A".repeat(43)}`);
if (!parsed.ok) throw new Error("invalid fixture");
const link = parsed.link;

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}
function client(expiresAt: number | null) {
  const handlers: Array<(message: string) => void> = [];
  return {
    expiresAt,
    connect: vi.fn(async () => {}),
    dispose: vi.fn(() => { for (const handler of handlers.splice(0)) handler("closed"); }),
    onClosed: (handler: (message: string) => void) => {
      handlers.push(handler);
      return () => { const at = handlers.indexOf(handler); if (at >= 0) handlers.splice(at, 1); };
    },
  };
}
function setup(expiresAt: number | null = null) {
  const store = storage();
  const clients: ReturnType<typeof client>[] = [];
  const connect = vi.fn(() => {
    const next = client(Date.now() + 60_000);
    clients.push(next);
    return next as unknown as WebTransportClient;
  });
  const events = { onConnecting: vi.fn(), onConnected: vi.fn(), onDisconnected: vi.fn(), onExpired: vi.fn() };
  const session = new RememberedSession({ link, expiresAt, storage: store, connect, ...events });
  return { session, store, clients, connect, ...events };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-20T00:00:00Z")); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe("인증 기억과 재연결", () => {
  it("인증 성공 뒤 저장하고 새 페이지에서도 같은 인증으로 접속한다", async () => {
    const first = setup();
    first.session.setVisible(true);
    await vi.advanceTimersByTimeAsync(0);
    const saved = readRememberedPairing(first.store)!;
    expect(saved.link).toEqual(link);
    first.session.dispose();
    const second = setup(saved.expiresAt);
    second.session.setVisible(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(second.connect).toHaveBeenCalledWith(saved.link);
    expect(second.onConnected).toHaveBeenCalledOnce();
    second.session.dispose();
  });

  it("화면 잠금 후 복귀하면 재인증하되 만료는 연장하지 않는다", async () => {
    const h = setup();
    h.session.setVisible(true);
    await vi.advanceTimersByTimeAsync(0);
    const expiry = readRememberedPairing(h.store)!.expiresAt;
    h.session.setVisible(false);
    expect(h.clients[0].dispose).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.connect).toHaveBeenCalledTimes(1);
    h.session.setVisible(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.connect).toHaveBeenCalledTimes(2);
    expect(readRememberedPairing(h.store)!.expiresAt).toBe(expiry);
    h.session.dispose();
  });

  it("떠난 페이지의 늦은 연결 성공은 저장하거나 화면을 다시 열지 않는다", async () => {
    const h = setup();
    let finish!: () => void;
    const pending = client(Date.now() + 60_000);
    pending.connect.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    h.connect.mockReturnValue(pending as unknown as WebTransportClient);
    h.session.setVisible(true);
    h.session.dispose();
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.onConnected).not.toHaveBeenCalled();
    expect(readRememberedPairing(h.store)).toBeNull();
  });

  it("만료되면 열린 연결을 닫고 저장 정보와 재시도를 없앤다", async () => {
    const h = setup();
    h.session.setVisible(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.onExpired).toHaveBeenCalledOnce();
    expect(readRememberedPairing(h.store)).toBeNull();
    expect(h.clients[0].dispose).toHaveBeenCalled();
    h.session.setVisible(false);
    h.session.setVisible(true);
    expect(h.connect).toHaveBeenCalledTimes(1);
  });

  it("인증 거절은 저장 정보를 지우고 재시도하지 않는다", async () => {
    const h = setup(Date.now() + 60_000);
    rememberPairing(h.store, { link, expiresAt: Date.now() + 60_000 });
    const rejected = client(null);
    rejected.connect.mockRejectedValue(new RemoteError(401, "unauthorized"));
    h.connect.mockReturnValue(rejected as unknown as WebTransportClient);
    h.session.setVisible(true);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.connect).toHaveBeenCalledTimes(1);
    expect(h.onExpired).toHaveBeenCalledOnce();
    expect(readRememberedPairing(h.store)).toBeNull();
  });

  it("일시적인 연결 실패는 세 번까지만 재시도한다", async () => {
    const h = setup(Date.now() + 60_000);
    const failed = client(null);
    failed.connect.mockRejectedValue(new Error("offline"));
    h.connect.mockReturnValue(failed as unknown as WebTransportClient);
    h.session.setVisible(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.connect).toHaveBeenCalledTimes(3);
    expect(h.onDisconnected).toHaveBeenLastCalledWith(expect.any(Error), false);
    h.session.dispose();
  });

  it("저장 실패를 연결 성공으로 표시하지 않는다", async () => {
    const h = setup();
    h.store.setItem = () => { throw new Error("quota"); };
    h.session.setVisible(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.onConnected).not.toHaveBeenCalled();
    expect(h.onDisconnected).toHaveBeenLastCalledWith(expect.objectContaining({message: expect.stringContaining("site storage")}), false);
    expect(h.connect).toHaveBeenCalledTimes(1);
    h.session.dispose();
  });
});

describe("저장된 연결 검증", () => {
  it("깨진 데이터와 만료된 인증을 제거한다", () => {
    const store = storage();
    for (const value of ["broken", "null", JSON.stringify({ expiresAt: Date.now() - 1, fragment: "#v=1" })]) {
      store.setItem(REMEMBERED_PAIRING_KEY, value);
      expect(readRememberedPairing(store)).toBeNull();
      expect(store.getItem(REMEMBERED_PAIRING_KEY)).toBeNull();
    }
  });
  it("14일보다 긴 만료와 잘못된 토큰을 저장하지 않는다", () => {
    const store = storage();
    expect(() => rememberPairing(store, {link, expiresAt: Date.now() + MAX_PAIRING_AGE_MS + 1})).toThrow();
    expect(() => rememberPairing(store, {link: {...link, token: "wrong"}, expiresAt: Date.now() + 1000})).toThrow();
  });
});
