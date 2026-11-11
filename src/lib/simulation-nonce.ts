import { keccak256, stringToHex } from "viem";

/** The transaction fields a simulation nonce is issued for. */
export interface SimulationNonceSubject {
  from: string;
  to: string;
  data: string;
  /** Decimal wei string; empty or undefined means 0. */
  value?: string;
}

const BINDING_RE = /^0x[0-9a-f]{64}$/;

export function isSimulationNonceBinding(value: unknown): value is `0x${string}` {
  return typeof value === "string" && BINDING_RE.test(value);
}

/**
 * Hash of the transaction a nonce may be used for. Computed in the browser
 * when requesting the nonce and recomputed by /api/simulate from the request
 * body, so the two must normalise identically.
 */
export function simulationNonceBinding(subject: SimulationNonceSubject): `0x${string}` {
  const value = subject.value ? BigInt(subject.value).toString() : "0";
  return keccak256(stringToHex(JSON.stringify([
    subject.from.toLowerCase(),
    subject.to.toLowerCase(),
    subject.data.toLowerCase(),
    value,
  ])));
}

/** String signed for a nonce bound to a request. */
export function boundNoncePayload(nonce: string, expires: number, binding: string): string {
  return `sim-nonce.v2.${nonce}.${expires}.${binding}`;
}

/** String signed for a share link. */
export function shareLinkPayload(simulationId: string): string {
  return `sim-share.v1.${simulationId}`;
}
