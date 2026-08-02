/**
 * @vitest-environment happy-dom
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { ProviderRecoveryDialog } from "@/app/[locale]/settings/providers/_components/provider-recovery-dialog";
import recoveryMessages from "../../../../messages/en/settings/recovery.json";

const recoveryApiMocks = vi.hoisted(() => ({
  getProviderRecoveryDiagnostics: vi.fn(),
  operateProviderRecovery: vi.fn(),
  updateProviderRecoveryConfiguration: vi.fn(),
}));

vi.mock("@/lib/api-client/v1/actions/recovery", () => recoveryApiMocks);

async function flushTicks(times = 3) {
  for (let index = 0; index < times; index += 1) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  }
}

describe("ProviderRecoveryDialog", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.clearAllMocks();
    recoveryApiMocks.getProviderRecoveryDiagnostics.mockResolvedValue({
      scope: { kind: "provider", providerId: 4 },
      state: {
        health: "recovering",
        epoch: 7,
        automationPaused: false,
        recoveryStageIndex: 1,
        failureCount: 2,
        trialOccupancy: 1,
        nextProbeAt: null,
        probeLeaseUntil: null,
        probeAttemptCount: 3,
        window: { total: 8, success: 7, failure: 1, slow: 2, hard: 0 },
      },
      configuration: {
        recovery: {
          openDurationMs: { configured: 100, effective: 200, source: "system" },
        },
        probeBudgets: {
          safeModel: { configured: "safe-model", effective: "safe-model", source: "code" },
        },
      },
      authority: { recovery: "enforce", binding: "v2_only" },
      degraded: false,
    });
    recoveryApiMocks.operateProviderRecovery.mockResolvedValue({
      code: "applied",
      epoch: 8,
      health: "closed",
    });
    recoveryApiMocks.updateProviderRecoveryConfiguration.mockResolvedValue({});
  });

  test("shows textual diagnostics and gates force close behind reason and confirmation", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    act(() =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <NextIntlClientProvider
            locale="en"
            messages={{ settings: { recovery: recoveryMessages } }}
            timeZone="UTC"
          >
            <ProviderRecoveryDialog providerId={4} />
          </NextIntlClientProvider>
        </QueryClientProvider>
      )
    );

    const trigger = document.querySelector(
      'button[aria-label="Recovery diagnostics"]'
    ) as HTMLButtonElement;
    await act(async () => trigger.click());
    await flushTicks();

    expect(document.body.textContent).toContain("Recovering");
    expect(document.body.textContent).toContain("8 outcomes, 7 successful, 1 failed, 2 slow");
    expect(document.body.textContent).toContain("Provider recovery overrides");

    const findOverrideInput = (labelText: string) =>
      [...document.querySelectorAll("label")]
        .find((label) => label.textContent?.includes(labelText))
        ?.querySelector("input") as HTMLInputElement;
    for (const [input, value] of [
      [findOverrideInput("Open duration"), "250"],
      [findOverrideInput("Probe timeout"), "32"],
    ] as const) {
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        setter?.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    }
    const firstBooleanOverride = document.querySelector("select") as HTMLSelectElement;
    await act(async () => {
      firstBooleanOverride.value = "true";
      firstBooleanOverride.dispatchEvent(new Event("change", { bubbles: true }));
    });

    const saveOverrides = [...document.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Save provider overrides")
    ) as HTMLButtonElement;
    await act(async () => saveOverrides.click());
    await flushTicks();
    expect(recoveryApiMocks.updateProviderRecoveryConfiguration).toHaveBeenCalledWith(
      4,
      expect.objectContaining({
        recoverySettings: expect.objectContaining({
          openDurationMs: 250,
          activeProbesEnabled: null,
        }),
        recoveryProbeBudgets: expect.objectContaining({
          safeModel: "safe-model",
          timeoutMs: 32,
        }),
      })
    );

    const forceClose = [...document.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Force close")
    ) as HTMLButtonElement;
    expect(forceClose.disabled).toBe(true);

    const reason = document.querySelector(
      'input[aria-label="Administrative reason"]'
    ) as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(reason, "verified upstream");
      reason.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flushTicks();
    const confirmation = document.querySelector(
      'button[aria-label^="I understand"]'
    ) as HTMLButtonElement;
    await act(async () => confirmation.click());
    await flushTicks();
    expect(forceClose.disabled).toBe(false);

    await act(async () => forceClose.click());
    await flushTicks(10);
    expect(recoveryApiMocks.operateProviderRecovery).toHaveBeenCalledWith(4, "force-close", {
      expectedEpoch: 7,
      reason: "verified upstream",
      confirmation: "FORCE_CLOSE",
    });

    act(() => root.unmount());
  });

  test("reports provider override and operation failures", async () => {
    recoveryApiMocks.updateProviderRecoveryConfiguration.mockRejectedValueOnce(
      new Error("configuration failed")
    );
    recoveryApiMocks.operateProviderRecovery.mockRejectedValueOnce(new Error("operation failed"));
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    act(() =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <NextIntlClientProvider
            locale="en"
            messages={{ settings: { recovery: recoveryMessages } }}
            timeZone="UTC"
          >
            <ProviderRecoveryDialog providerId={4} />
          </NextIntlClientProvider>
        </QueryClientProvider>
      )
    );
    await act(async () =>
      (document.querySelector('button[aria-label="Recovery diagnostics"]') as HTMLElement).click()
    );
    await flushTicks();
    const reason = document.querySelector(
      'input[aria-label="Administrative reason"]'
    ) as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(reason, "failure path");
      reason.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flushTicks();
    const saveOverrides = [...document.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Save provider overrides")
    ) as HTMLButtonElement;
    await act(async () => saveOverrides.click());
    await flushTicks();
    const forceOpen = [...document.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Force open")
    ) as HTMLButtonElement;
    await act(async () => forceOpen.click());
    await flushTicks();

    act(() => root.unmount());
    container.remove();
  });

  test("shows degraded status and disables permissive recovery operations", async () => {
    recoveryApiMocks.getProviderRecoveryDiagnostics.mockResolvedValueOnce({
      scope: { kind: "provider", providerId: 4 },
      state: {
        health: "open",
        epoch: 8,
        automationPaused: true,
        recoveryStageIndex: 0,
        failureCount: 3,
        trialOccupancy: 0,
        nextProbeAt: null,
        probeLeaseUntil: null,
        probeAttemptCount: 1,
        window: { total: 0, success: 0, failure: 0, slow: 0, hard: 0 },
      },
      configuration: {},
      authority: { recovery: "enforce", binding: "v2_only" },
      degraded: true,
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    act(() =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <NextIntlClientProvider
            locale="en"
            messages={{ settings: { recovery: recoveryMessages } }}
            timeZone="UTC"
          >
            <ProviderRecoveryDialog providerId={4} />
          </NextIntlClientProvider>
        </QueryClientProvider>
      )
    );

    const trigger = document.querySelector(
      'button[aria-label="Recovery diagnostics"]'
    ) as HTMLButtonElement;
    await act(async () => trigger.click());
    await flushTicks();

    expect(document.body.textContent).toContain("Degraded");
    const reason = document.querySelector(
      'input[aria-label="Administrative reason"]'
    ) as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(reason, "redis unavailable");
      reason.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flushTicks();
    for (const label of ["Run probe", "Resume", "Safe reset", "Force close"]) {
      const button = [...document.querySelectorAll("button")].find((candidate) =>
        candidate.textContent?.includes(label)
      ) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
    }
    const forceOpen = [...document.querySelectorAll("button")].find((candidate) =>
      candidate.textContent?.includes("Force open")
    ) as HTMLButtonElement;
    expect(forceOpen.disabled).toBe(false);

    act(() => root.unmount());
  });
});
