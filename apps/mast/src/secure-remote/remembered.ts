import { base64urlEncode } from "./base64url";
import { parsePairingFragment } from "./pairing";
import type { PairingLink } from "./pairing";

export class PairingStorageError extends Error {
  constructor() { super("Could not save this phone’s pairing. Allow site storage, then scan the QR again."); }
}

export const REMEMBERED_PAIRING_KEY = "mast.secure-remote.pairing.v1";
export const MAX_PAIRING_AGE_MS = 14 * 24 * 60 * 60 * 1000;
export interface RememberedPairing {
  link: PairingLink;
  expiresAt: number;
}
export type PairingStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function forgetPairing(storage: PairingStorage): void {
  try { storage.removeItem(REMEMBERED_PAIRING_KEY); } catch { throw new PairingStorageError(); }
}

export function rememberPairing(storage: PairingStorage, pairing: RememberedPairing): void {
  const { link, expiresAt } = pairing;
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + MAX_PAIRING_AGE_MS) {
    throw new Error("Invalid remembered pairing expiry");
  }
  const fragment = `#v=1&host=${link.host}&port=${link.port}&cert=${base64urlEncode(link.certHash)}&token=${link.token}`;
  if (!parsePairingFragment(fragment).ok) throw new Error("Invalid remembered pairing");
  try { storage.setItem(REMEMBERED_PAIRING_KEY, JSON.stringify({ expiresAt, fragment })); }
  catch { throw new PairingStorageError(); }
}

export function readRememberedPairing(storage: PairingStorage): RememberedPairing | null {
  const raw = storage.getItem(REMEMBERED_PAIRING_KEY);
  if (raw === null) return null;
  let saved: unknown;
  try { saved = JSON.parse(raw); } catch { saved = null; }
  if (typeof saved === "object" && saved !== null) {
    const { expiresAt, fragment } = saved as Record<string, unknown>;
    if (typeof expiresAt === "number" && Number.isSafeInteger(expiresAt) &&
        expiresAt > Date.now() && expiresAt <= Date.now() + MAX_PAIRING_AGE_MS && typeof fragment === "string") {
      const parsed = parsePairingFragment(fragment);
      if (parsed.ok) return { link: parsed.link, expiresAt };
    }
  }
  forgetPairing(storage);
  return null;
}
