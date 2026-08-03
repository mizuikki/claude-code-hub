import { createCoverageConfig } from "../vitest.base.mts";

export default createCoverageConfig({
  name: "responses-compaction-v2",
  environment: "node",
  testFiles: ["src/app/v1/_lib/proxy/responses-compaction-v2.test.ts"],
  sourceFiles: ["src/app/v1/_lib/proxy/responses-compaction-v2.ts"],
  thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
});
