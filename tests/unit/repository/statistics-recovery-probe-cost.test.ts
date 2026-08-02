import { beforeEach, describe, expect, test, vi } from "vitest";

const totals: number[] = [];
const whereMock = vi.fn(async () => [{ total: totals.shift() ?? 0 }]);
const fromMock = vi.fn(() => ({ where: whereMock }));
const selectMock = vi.fn(() => ({ from: fromMock }));

vi.mock("@/drizzle/db", () => ({
  db: { select: selectMock, execute: vi.fn(async () => []) },
}));

describe("provider recovery probe cost accounting", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    totals.length = 0;
  });

  test("includes known probe cost in provider total quota", async () => {
    totals.push(1.25, 0.5);
    const { sumProviderTotalCost } = await import("@/repository/statistics");

    await expect(sumProviderTotalCost(7)).resolves.toBe(1.75);
    expect(selectMock).toHaveBeenCalledTimes(2);
    expect(fromMock).toHaveBeenCalledTimes(2);
  });

  test("includes known probe cost in bounded provider windows", async () => {
    totals.push(2, 0.125);
    const { sumProviderCostInTimeRange } = await import("@/repository/statistics");

    await expect(
      sumProviderCostInTimeRange(
        7,
        new Date("2026-08-01T00:00:00.000Z"),
        new Date("2026-08-02T00:00:00.000Z")
      )
    ).resolves.toBe(2.125);
    expect(selectMock).toHaveBeenCalledTimes(2);
  });
});
