import { readFile } from "node:fs/promises";

export async function loadMcpInstructions(metadataUrl = new URL("./description.md", import.meta.url)) {
  return (await readFile(metadataUrl, "utf8")).trim();
}
