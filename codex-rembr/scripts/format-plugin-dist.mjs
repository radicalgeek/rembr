import { readdirSync, readFileSync, writeFileSync } from "node:fs"

for (const name of readdirSync("plugin-dist")) {
  const path = `plugin-dist/${name}`
  writeFileSync(path, readFileSync(path, "utf8").replace(/[ \t]+$/gm, ""))
}
