import { describe, expect, test } from "vitest";
import en from "../../../messages/en/settings/recovery.json";
import ja from "../../../messages/ja/settings/recovery.json";
import ru from "../../../messages/ru/settings/recovery.json";
import zhCN from "../../../messages/zh-CN/settings/recovery.json";
import zhTW from "../../../messages/zh-TW/settings/recovery.json";

function paths(value: unknown, prefix = ""): string[] {
  if (!value || typeof value !== "object") return [prefix];
  return Object.entries(value).flatMap(([key, child]) =>
    paths(child, prefix ? `${prefix}.${key}` : key)
  );
}

describe("recovery locale parity", () => {
  test("keeps every recovery key in all five locales", () => {
    const expected = paths(en).sort();
    for (const messages of [zhCN, zhTW, ja, ru]) {
      expect(paths(messages).sort()).toEqual(expected);
    }
  });
});
