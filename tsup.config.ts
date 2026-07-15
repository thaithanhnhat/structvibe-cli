import { defineConfig } from "tsup";
import packageJson from "./package.json";

export default defineConfig({
  entry: ["src/bin.ts"],
  format: ["esm"],
  platform: "node",
  target: "node20",
  bundle: true,
  dts: false,
  sourcemap: true,
  clean: true,
  define: {
    __STRUCTVIBE_CLI_VERSION__: JSON.stringify(packageJson.version)
  },
  banner: { js: "#!/usr/bin/env node" }
});
