import { z } from "zod";
import {
  type CachedDeviceFeatures,
  type Device,
  deviceSearchFields,
  fieldsMatchQuery,
  type SearchFuzziness,
  type DeviceStatus,
  nodeIsOnline,
  pruneDeviceFeaturesForQuery,
  readCachedDevicesWithFeatures
} from "./common.js";
import { defineTool } from "../tool-definition.js";
import { documentModules, type DocumentedModule } from "../function-docs.js";

export type SearchDevicesInput = {
  query: string;
  fuzziness?: SearchFuzziness;
  status?: DeviceStatus;
  includeStatus?: boolean;
};

type SearchDeviceResult = Omit<Device, "features"> & {
  features?: Omit<CachedDeviceFeatures, "deviceNote" | "modules"> & {
    modules: DocumentedModule[];
  };
};

function stripNestedDeviceContext(features?: CachedDeviceFeatures) {
  if (!features) {
    return undefined;
  }

  const { deviceNote: _deviceNote, ...rest } = features;
  return rest;
}

function moduleSearchTerms(queries: string[], deviceNote: string) {
  const noteWords = deviceNote.toLowerCase().match(/[a-z0-9]+/g)?.filter((word) => word.length > 2) ?? [];
  return [...new Set([...queries, ...noteWords])];
}

export async function searchDevices(input: SearchDevicesInput) {
  const { devices } = await readCachedDevicesWithFeatures();
  const query = input.query.trim().toLowerCase();
  const fuzziness = input.fuzziness ?? 1;
  const includeStatus = Boolean(input.includeStatus) || input.status !== undefined;
  const queryWords = [...new Set(query.match(/[a-z0-9]+/g) ?? [])];

  async function searchWithTerms(queries: string[]) {
    const matches: SearchDeviceResult[] = [];

    for (const device of devices) {
      if (!queries.some((term) => fieldsMatchQuery(deviceSearchFields(device), term, fuzziness))) {
        continue;
      }

      const { features, ...deviceFields } = device;
      const outputDevice: SearchDeviceResult = { ...deviceFields };
      const outputFeatures = features
        ? pruneDeviceFeaturesForQuery(features, moduleSearchTerms(queries, outputDevice.deviceNote ?? ""), fuzziness)
        : undefined;

      const featuresWithoutContext = stripNestedDeviceContext(outputFeatures);

      if (featuresWithoutContext) {
        outputDevice.features = {
          ...featuresWithoutContext,
          modules: await documentModules(featuresWithoutContext.modules)
        };
      }

      if (includeStatus) {
        outputDevice.status = (await nodeIsOnline(outputDevice.ip, outputDevice.port)) ? "online" : "offline";
      }

      if (input.status && outputDevice.status !== input.status) {
        continue;
      }

      matches.push(outputDevice);
    }

    return matches;
  }

  let matchedTerms = [query];
  let matchMode: "query" | "words" = "query";
  let matches = await searchWithTerms(matchedTerms);

  if (matches.length === 0 && queryWords.length > 1) {
    matchedTerms = queryWords;
    matchMode = "words";
    matches = await searchWithTerms(matchedTerms);
  }

  return {
    query: input.query,
    fuzziness,
    matchMode,
    matchedTerms,
    status: input.status ?? null,
    count: matches.length,
    devices: matches
  };
}

export const searchDevicesTool = defineTool<SearchDevicesInput>(import.meta.url, {
  _meta: {
    "microsmcp/ui": {
      hiddenInputs: ["includeStatus"]
    }
  },
  inputSchema: {
    query: z
      .string()
      .min(1)
      .describe(
        "Device or capability text to search across cached identity, notes, modules, and complete function signatures. Multi-word queries retry with individual words only when the full query has no matches."
      ),
    fuzziness: z
      .number()
      .int()
      .min(0)
      .max(2)
      .default(1)
      .describe("Search tolerance: 0 uses literal substrings, 1 allows close spellings (default), and 2 is broader."),
    status: z.enum(["online", "offline"]).optional().describe("Optional live reachability requirement. Omit for any status."),
    includeStatus: z.boolean().optional().describe("Check live online/offline status for matched devices.")
  },
  handler: searchDevices
});
