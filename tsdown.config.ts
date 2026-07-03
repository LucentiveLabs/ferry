import { defineConfig } from "tsdown";

export default defineConfig({
  // Two entries: the library (index) and the bin (cli). The cli entry carries a
  // `#!/usr/bin/env node` shebang in source; tsdown/rolldown preserves it and
  // marks the output executable so `bin` works after install.
  entry: ["src/index.ts", "src/cli.ts"],
  format: ["esm"],
  fixedExtension: false,
  dts: true,
  clean: true,
  // Ferry has ZERO runtime dependencies — nothing to bundle-external.
});
