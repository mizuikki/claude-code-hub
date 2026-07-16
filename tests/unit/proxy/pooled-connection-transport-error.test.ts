/**
 * Pooled connection transport error detection + SYSTEM_ERROR retry backoff.
 */
import { describe, expect, it } from "vitest";
import {
  getSystemErrorRetryDelayMs,
  isPooledConnectionTransportError,
} from "@/app/v1/_lib/proxy/errors";

describe("isPooledConnectionTransportError", () => {
  it("detects ECONNRESET", () => {
    const err = new Error("read ECONNRESET");
    (err as NodeJS.ErrnoException).code = "ECONNRESET";
    expect(isPooledConnectionTransportError(err)).toBe(true);
  });

  it("detects UND_ERR_SOCKET", () => {
    const err = new Error("Socket error");
    (err as NodeJS.ErrnoException).code = "UND_ERR_SOCKET";
    expect(isPooledConnectionTransportError(err)).toBe(true);
  });

  it("detects EPIPE", () => {
    const err = new Error("write EPIPE");
    (err as NodeJS.ErrnoException).code = "EPIPE";
    expect(isPooledConnectionTransportError(err)).toBe(true);
  });

  it("detects ERR_STREAM_PREMATURE_CLOSE", () => {
    const err = new Error("Premature close");
    (err as NodeJS.ErrnoException).code = "ERR_STREAM_PREMATURE_CLOSE";
    expect(isPooledConnectionTransportError(err)).toBe(true);
  });

  it("detects SocketError by name", () => {
    const err = new Error("socket hang up");
    err.name = "SocketError";
    expect(isPooledConnectionTransportError(err)).toBe(true);
  });

  it("detects other side closed message", () => {
    expect(isPooledConnectionTransportError(new Error("other side closed"))).toBe(true);
  });

  it("detects nested cause code", () => {
    const root = new Error("read ECONNRESET");
    (root as NodeJS.ErrnoException).code = "ECONNRESET";
    const wrapped = new Error("fetch failed", { cause: root });
    expect(isPooledConnectionTransportError(wrapped)).toBe(true);
  });

  it("does not treat ENOTFOUND as pooled-connection poison", () => {
    const err = new Error("getaddrinfo ENOTFOUND example.com");
    (err as NodeJS.ErrnoException).code = "ENOTFOUND";
    expect(isPooledConnectionTransportError(err)).toBe(false);
  });

  it("does not treat generic application errors as pooled-connection poison", () => {
    expect(isPooledConnectionTransportError(new Error("invalid_request_error"))).toBe(false);
  });

  it("returns false for non-Error values", () => {
    expect(isPooledConnectionTransportError("ECONNRESET")).toBe(false);
    expect(isPooledConnectionTransportError(null)).toBe(false);
  });
});

describe("getSystemErrorRetryDelayMs", () => {
  it("returns 250ms after the first failed attempt", () => {
    expect(getSystemErrorRetryDelayMs(1)).toBe(250);
  });

  it("returns 500ms after the second failed attempt", () => {
    expect(getSystemErrorRetryDelayMs(2)).toBe(500);
  });

  it("caps at 1000ms for later attempts", () => {
    expect(getSystemErrorRetryDelayMs(3)).toBe(1000);
    expect(getSystemErrorRetryDelayMs(10)).toBe(1000);
  });

  it("treats invalid attempt numbers as first-attempt delay", () => {
    expect(getSystemErrorRetryDelayMs(0)).toBe(250);
    expect(getSystemErrorRetryDelayMs(Number.NaN)).toBe(250);
  });
});
