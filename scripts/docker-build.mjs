#!/usr/bin/env node
import { createReadStream, createWriteStream, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

const defaultImage = "microsmcp:latest";
const defaultOutput = "dist/microsmcp-docker-image.tar.gz";

function printHelp() {
  console.log(`Usage:
  node scripts/docker-build.mjs [options]

Options:
  --image <name:tag>   Docker image tag to build. Default: ${defaultImage}
  --output <path>      Export image path. Use .tar or .tar.gz. Default: ${defaultOutput}
  --no-export          Build the image without docker save.
  -h, --help           Show this help.

Examples:
  npm run docker:build
  npm run docker:build -- --image microsmcp:dev
  npm run docker:build -- --output dist/microsmcp.tar
  npm run docker:build -- --no-export
`);
}

function readOptions(argv) {
  const options = {
    image: defaultImage,
    output: defaultOutput,
    exportImage: true
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "-h" || arg === "--help") {
      return { help: true, options };
    }

    if (arg === "--no-export") {
      options.exportImage = false;
      continue;
    }

    if (arg === "--image" || arg === "--output") {
      const value = argv[index + 1];

      if (!value) {
        throw new Error(`Missing value for ${arg}`);
      }

      if (arg === "--image") {
        options.image = value;
      } else {
        options.output = value;
      }

      index += 1;
      continue;
    }

    throw new Error(`Unknown option: ${arg}`);
  }

  return { help: false, options };
}

function run(command, args) {
  const result = spawnSync(command, args, {
    stdio: "inherit"
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }
}

async function saveImage(image, output) {
  const outputPath = resolve(output);
  mkdirSync(dirname(outputPath), { recursive: true });

  if (!outputPath.endsWith(".gz")) {
    run("docker", ["save", "-o", outputPath, image]);
    return outputPath;
  }

  const tarPath = outputPath.replace(/\.gz$/, "");
  run("docker", ["save", "-o", tarPath, image]);

  try {
    await pipeline(createReadStream(tarPath), createGzip(), createWriteStream(outputPath));
  } finally {
    rmSync(tarPath, { force: true });
  }

  return outputPath;
}

try {
  const { help, options } = readOptions(process.argv.slice(2));

  if (help) {
    printHelp();
    process.exit(0);
  }

  run("docker", ["build", "-t", options.image, "."]);

  if (options.exportImage) {
    const outputPath = await saveImage(options.image, options.output);
    console.log(`Exported ${options.image} to ${outputPath}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
