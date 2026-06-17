#!/usr/bin/env node
import { copyFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const sourceDir = "mcp";
const targetDir = "dist/mcp";

function copyMarkdownFiles(dir) {
  for (const entry of readdirSync(dir)) {
    const sourcePath = join(dir, entry);
    const stat = statSync(sourcePath);

    if (stat.isDirectory()) {
      copyMarkdownFiles(sourcePath);
      continue;
    }

    if (!sourcePath.endsWith(".md")) {
      continue;
    }

    const targetPath = join(targetDir, relative(sourceDir, sourcePath));
    mkdirSync(dirname(targetPath), { recursive: true });
    copyFileSync(sourcePath, targetPath);
  }
}

copyMarkdownFiles(sourceDir);
