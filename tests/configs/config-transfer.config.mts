import { createCoverageConfig } from "../vitest.base.mts";

export default createCoverageConfig({
  name: "config-transfer",
  environment: "node",
  testFiles: ["tests/unit/config-transfer.test.ts"],
  sourceFiles: ["scripts/config-transfer.ts"],
  thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
});
