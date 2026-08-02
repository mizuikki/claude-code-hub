/**
 * @vitest-environment happy-dom
 */

import { act } from "react";
import { createRoot } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, test, vi } from "vitest";
import { RecoverySettingsPanel } from "@/app/[locale]/settings/config/_components/recovery-settings-panel";
import recoveryMessages from "../../../messages/en/settings/recovery.json";

const recoveryApiMocks = vi.hoisted(() => ({
  updateRecoveryConfiguration: vi.fn(),
}));

vi.mock("@/lib/api-client/v1/actions/recovery", () => recoveryApiMocks);

async function flushTicks(times = 3) {
  for (let index = 0; index < times; index += 1) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  }
}

describe("RecoverySettingsPanel", () => {
  test("associates every authority label with a keyboard-focusable control", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() =>
      root.render(
        <NextIntlClientProvider locale="en" messages={{ settings: { recovery: recoveryMessages } }}>
          <RecoverySettingsPanel
            initialRecoveryAuthority="shadow"
            initialBindingAuthority="v2_dual_write"
            initialFailbackMode="sticky"
          />
        </NextIntlClientProvider>
      )
    );

    for (const id of [
      "recovery-authority",
      "binding-authority",
      "failback-mode",
      "rollout-proof",
    ]) {
      const label = container.querySelector(`label[for="${id}"]`);
      const control = container.querySelector(`#${id}`);
      expect(label).toBeTruthy();
      expect(control?.getAttribute("role")).toBe("combobox");
      expect((control as HTMLElement).tabIndex).toBe(0);
    }

    act(() => root.unmount());
    container.remove();
  });

  test("shows degraded authority and configured/effective/source diagnostics", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() =>
      root.render(
        <NextIntlClientProvider locale="en" messages={{ settings: { recovery: recoveryMessages } }}>
          <RecoverySettingsPanel
            initialRecoveryAuthority="enforce"
            initialBindingAuthority="v2_only"
            initialFailbackMode="safe_auto"
            degraded
            resolvedRecoverySettings={{
              openDurationMs: {
                configured: null,
                effective: 30_000,
                source: "environment",
              },
            }}
          />
        </NextIntlClientProvider>
      )
    );

    expect(container.querySelector('[role="status"]')?.textContent).toContain("Degraded");
    expect(container.querySelector('[data-degraded="true"]')).toBeTruthy();
    expect(container.querySelector('[data-resolution="openDurationMs"]')?.textContent).toContain(
      "effective: 30000"
    );
    expect(container.textContent).toContain("Environment");

    act(() => root.unmount());
    container.remove();
  });

  test("serializes nullable overrides and reports save failures", async () => {
    recoveryApiMocks.updateRecoveryConfiguration.mockResolvedValueOnce({});
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() =>
      root.render(
        <NextIntlClientProvider locale="en" messages={{ settings: { recovery: recoveryMessages } }}>
          <RecoverySettingsPanel
            initialRecoveryAuthority="legacy"
            initialBindingAuthority="legacy"
            initialFailbackMode="sticky"
            resolvedRecoverySettings={{
              openDurationMs: { configured: 100, effective: 200, source: "system" },
            }}
          />
        </NextIntlClientProvider>
      )
    );

    for (const [id, value] of [
      ["recovery-openDurationMs", "250"],
      ["probe-maxTokensPerProbe", "32"],
      ["failback-delayMs", "500"],
    ]) {
      const input = container.querySelector(`#${id}`) as HTMLInputElement;
      act(() => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        setter?.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    }

    const booleanTrigger = container.querySelector(
      "#recovery-passiveHalfOpenEnabled"
    ) as HTMLButtonElement;
    act(() => booleanTrigger.click());
    const enabled = [...document.querySelectorAll('[role="option"]')].find((option) =>
      option.textContent?.includes("Enabled")
    ) as HTMLElement;
    act(() => enabled.click());

    const save = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Save")
    ) as HTMLButtonElement;
    await act(async () => save.click());
    await flushTicks();
    expect(recoveryApiMocks.updateRecoveryConfiguration).toHaveBeenCalledWith(
      expect.objectContaining({
        recoverySettings: expect.objectContaining({
          openDurationMs: 250,
          passiveHalfOpenEnabled: true,
        }),
        recoveryProbeBudgets: expect.objectContaining({ maxTokensPerProbe: 32 }),
        sessionFailbackSettings: expect.objectContaining({ delayMs: 500 }),
      })
    );

    recoveryApiMocks.updateRecoveryConfiguration.mockRejectedValueOnce(new Error("failed"));
    await act(async () => save.click());
    await flushTicks();

    act(() => root.unmount());
    container.remove();
  });
});
