/**
 * @vitest-environment happy-dom
 */

import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LogsDateRangePicker } from "@/app/[locale]/dashboard/logs/_components/logs-date-range-picker";

const tMock = vi.hoisted(() => {
  const messages: Record<string, string> = {
    "dashboard.logs.filters.customRange": "Custom range",
    "dashboard.logs.filters.last7days": "Last 7 days",
    "dashboard.logs.filters.last30days": "Last 30 days",
    "dashboard.logs.filters.reset": "Reset",
    "dashboard.leaderboard.dateRange.to": "to",
    "dashboard.leaderboard.dateRange.prevPeriod": "Previous period",
    "dashboard.leaderboard.dateRange.nextPeriod": "Next period",
    "common.today": "Today",
    "common.yesterday": "Yesterday",
  };

  return vi.fn((namespace: string) => (key: string) => messages[`${namespace}.${key}`] ?? key);
});

vi.mock("next-intl", () => ({
  useTranslations: (namespace: string) => tMock(namespace),
}));

function TestHarness({
  initialStartDate,
  initialEndDate,
  serverTimeZone = "UTC",
}: {
  initialStartDate?: string;
  initialEndDate?: string;
  serverTimeZone?: string;
}) {
  const [range, setRange] = useState({
    startDate: initialStartDate,
    endDate: initialEndDate,
  });

  return (
    <LogsDateRangePicker
      startDate={range.startDate}
      endDate={range.endDate}
      serverTimeZone={serverTimeZone}
      onDateRangeChange={(nextRange) => setRange(nextRange)}
    />
  );
}

function getButtonByTitle(container: HTMLElement, title: string): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(`button[title="${title}"]`);
  if (!button) {
    throw new Error(`Button with title "${title}" was not found`);
  }
  return button;
}

describe("LogsDateRangePicker", () => {
  let container: HTMLDivElement | null = null;
  let root: ReturnType<typeof createRoot> | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T23:59:00Z"));
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    if (root) {
      act(() => root!.unmount());
      root = null;
    }
    if (container) {
      container.remove();
      container = null;
    }
    vi.useRealTimers();
  });

  it("refreshes the next-period boundary after midnight without a remount", async () => {
    await act(async () => {
      root!.render(<TestHarness initialStartDate="2026-06-01" initialEndDate="2026-06-01" />);
    });

    const nextButton = getButtonByTitle(container!, "Next period");
    expect(nextButton.disabled).toBe(true);

    await act(async () => {
      vi.advanceTimersByTime(61_000);
    });

    expect(getButtonByTitle(container!, "Next period").disabled).toBe(false);
  });
});
