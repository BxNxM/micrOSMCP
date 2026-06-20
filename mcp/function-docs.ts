import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { DiscoveredModule } from "./tools/common.js";

type FunctionManualModule = Record<string, unknown>;
type FunctionManual = Record<string, FunctionManualModule>;

export type DocumentedFunction = {
  name: string;
  signature: string;
  doc?: string;
};

export type DocumentedModule = {
  name: string;
  functions: DocumentedFunction[];
};

export const functionManualPath =
  process.env.MICROS_FUNCTION_MANUAL_PATH ?? resolve(process.cwd(), "data/sfuncman.json");

let manualPromise: Promise<FunctionManual> | null = null;

function normalizeManual(input: unknown): FunctionManual {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(input).filter(([_name, value]) => value && typeof value === "object" && !Array.isArray(value))
  ) as FunctionManual;
}

async function readFunctionManual() {
  manualPromise ??= readFile(functionManualPath, "utf8")
    .then((raw) => normalizeManual(JSON.parse(raw)))
    .catch(() => ({}));
  return manualPromise;
}

function caseInsensitiveEntry<T>(record: Record<string, T> | undefined, name: string) {
  if (!record) {
    return undefined;
  }

  return record[name] ?? Object.entries(record).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
}

function functionName(signature: string) {
  return signature.trim().split(/\s+/, 1)[0] ?? "";
}

export async function documentModules(modules: DiscoveredModule[]): Promise<DocumentedModule[]> {
  const manual = await readFunctionManual();

  return modules.map((module) => {
    const moduleManual = caseInsensitiveEntry(manual, module.name);

    return {
      name: module.name,
      functions: module.functions.map((signature) => {
        const name = functionName(signature);
        const entry = caseInsensitiveEntry(moduleManual, name);
        const rawDoc =
          entry && typeof entry === "object" && !Array.isArray(entry)
            ? (entry as Record<string, unknown>).doc
            : undefined;
        const doc =
          typeof rawDoc === "string" ? rawDoc.trim() : "";

        return {
          name,
          signature,
          ...(doc ? { doc } : {})
        };
      })
    };
  });
}
