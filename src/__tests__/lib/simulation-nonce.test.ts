import { describe, expect, it } from "vitest";
import {
  isSimulationNonceBinding,
  simulationNonceBinding,
  type SimulationNonceSubject,
} from "@/lib/simulation-nonce";

const subject: SimulationNonceSubject = {
  from: "0xf75584ef6673ad213a685a1b58cc0330b8ea22cf",
  to: "0x6566194141eefa99af43bb5aa71460ca2dc90245",
  data: "0x21025a06",
  value: "0",
};

describe("simulationNonceBinding", () => {
  it("is a 0x-prefixed 64-char lowercase hex string", () => {
    expect(simulationNonceBinding(subject)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("is identical for mixed-case vs lowercase from/to/data", () => {
    const mixed = {
      ...subject,
      from: subject.from.toUpperCase().replace(/^0X/, "0x"),
      to: subject.to.toUpperCase().replace(/^0X/, "0x"),
      data: "0x21025A06",
    };
    expect(simulationNonceBinding(mixed)).toBe(simulationNonceBinding(subject));
  });

  it("treats undefined, empty and zero values alike", () => {
    const expected = simulationNonceBinding(subject);
    expect(simulationNonceBinding({ ...subject, value: undefined })).toBe(expected);
    expect(simulationNonceBinding({ ...subject, value: "" })).toBe(expected);
    expect(simulationNonceBinding({ ...subject, value: "00" })).toBe(expected);
  });

  it("changes when any single field changes", () => {
    const expected = simulationNonceBinding(subject);
    expect(simulationNonceBinding({ ...subject, from: "0x0000000000000000000000000000000000000001" })).not.toBe(expected);
    expect(simulationNonceBinding({ ...subject, to: "0x0000000000000000000000000000000000000002" })).not.toBe(expected);
    expect(simulationNonceBinding({ ...subject, data: "0x21025a07" })).not.toBe(expected);
    expect(simulationNonceBinding({ ...subject, value: "1" })).not.toBe(expected);
  });
});

describe("isSimulationNonceBinding", () => {
  it("accepts a valid binding", () => {
    expect(isSimulationNonceBinding(simulationNonceBinding(subject))).toBe(true);
  });

  it("rejects uppercase hex", () => {
    expect(isSimulationNonceBinding(`0x${"A".repeat(64)}`)).toBe(false);
  });

  it("rejects a 63-digit value", () => {
    expect(isSimulationNonceBinding(`0x${"a".repeat(63)}`)).toBe(false);
  });

  it("rejects a non-string", () => {
    expect(isSimulationNonceBinding(42)).toBe(false);
    expect(isSimulationNonceBinding(null)).toBe(false);
  });
});
