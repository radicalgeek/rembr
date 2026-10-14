import { RembrPlugin } from "./index.js"
import { RembrPluginV2 } from "./v2.js"

// One default export for both hosts: OpenCode v2 calls `setup()`, OpenCode v1
// (object entrypoints, 1.16.2+) calls `server()` with the plugin options.
export default {
  ...RembrPluginV2,
  server: RembrPlugin,
}
