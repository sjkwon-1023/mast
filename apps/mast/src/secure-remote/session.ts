import { RemoteError } from "../remote/transport";
import type { PairingLink } from "./pairing";
import { forgetPairing, rememberPairing, PairingStorageError } from "./remembered";
import type { PairingStorage } from "./remembered";
import { WebTransportClient } from "./transport";

export interface SessionOptions {
  link: PairingLink;
  expiresAt: number | null;
  storage: PairingStorage;
  connect?: (link: PairingLink) => WebTransportClient;
  onConnecting(): void;
  onConnected(client: WebTransportClient): void;
  onDisconnected(error: unknown, retrying: boolean): void;
  onExpired(): void;
}

/** 연결만 다시 만든다. 이전 연결의 입력·요청은 재전송하지 않는다. */
export class RememberedSession {
  private client: WebTransportClient | null = null;
  private generation = 0;
  private visible = false;
  private attempts = 0;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private expiry: ReturnType<typeof setTimeout> | null = null;
  private expiresAt: number | null;
  private expired = false;

  constructor(private readonly options: SessionOptions) {
    this.expiresAt = options.expiresAt;
    this.armExpiry();
  }

  setVisible(visible: boolean): void {
    if (this.visible === visible || this.expired) return;
    this.visible = visible;
    this.stopConnection();
    if (visible) {
      this.attempts = 0;
      void this.connect();
    }
  }

  dispose(): void {
    this.visible = false;
    this.stopConnection();
    if (this.expiry !== null) clearTimeout(this.expiry);
    this.expiry = null;
  }

  private stopConnection(): void {
    this.generation += 1;
    if (this.retry !== null) clearTimeout(this.retry);
    this.retry = null;
    const client = this.client;
    this.client = null;
    client?.dispose();
  }

  private expire(): void {
    this.expired = true;
    this.dispose();
    try { forgetPairing(this.options.storage); }
    catch (error) { this.options.onDisconnected(error, false); return; }
    this.options.onExpired();
  }

  private armExpiry(): void {
    if (this.expiry !== null) clearTimeout(this.expiry);
    if (this.expiresAt === null) return;
    this.expiry = setTimeout(() => this.expire(), Math.max(0, this.expiresAt - Date.now()));
  }

  private async connect(): Promise<void> {
    if (!this.visible || this.expired) return;
    if (this.expiresAt !== null && this.expiresAt <= Date.now()) {
      this.expire();
      return;
    }
    const generation = ++this.generation;
    const client = this.options.connect?.(this.options.link) ?? new WebTransportClient(this.options.link);
    this.client = client;
    this.attempts += 1;
    this.options.onConnecting();
    try {
      await client.connect();
      if (generation !== this.generation) { client.dispose(); return; }
      if (client.expiresAt !== null) {
        this.expiresAt = this.expiresAt === null ? client.expiresAt : Math.min(this.expiresAt, client.expiresAt);
        rememberPairing(this.options.storage, { link: this.options.link, expiresAt: this.expiresAt });
        this.armExpiry();
      }
      this.attempts = 0;
      client.onClosed((message) => {
        if (generation !== this.generation) return;
        this.failed(new Error(message));
      });
      this.options.onConnected(client);
    } catch (error) {
      if (generation !== this.generation) return;
      client.dispose();
      if (error instanceof PairingStorageError) {
        this.stopConnection();
        this.options.onDisconnected(error, false);
        return;
      }
      if (error instanceof RemoteError && (error.status === 401 || error.status === 503)) {
        this.expire();
        return;
      }
      this.failed(error);
    }
  }

  private failed(error: unknown): void {
    this.stopConnection();
    const retrying = this.visible && this.expiresAt !== null && this.attempts < 3;
    this.options.onDisconnected(error, retrying);
    if (retrying) this.retry = setTimeout(() => { this.retry = null; void this.connect(); }, 5000);
  }
}
