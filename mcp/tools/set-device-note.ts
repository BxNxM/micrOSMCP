import { z } from "zod";
import {
  cacheToDevices,
  deviceFeatureCachePath,
  emptyCachedDeviceFeatures,
  findDevices,
  readDeviceCache,
  readDeviceFeatureCache,
  saveDeviceFeatureCache
} from "./common.js";
import { defineTool } from "./definition.js";

export type SetDeviceNoteInput = {
  deviceTag: string;
  note?: string;
  mode?: "replace" | "append" | "clear";
};

export async function setDeviceNote(input: SetDeviceNoteInput) {
  const cache = await readDeviceCache();
  const matches = findDevices(cacheToDevices(cache), input.deviceTag);

  if (matches.length === 0) {
    return {
      ok: false,
      deviceTag: input.deviceTag,
      error: `Unknown device: ${input.deviceTag}`,
      matches: []
    };
  }

  if (matches.length > 1) {
    return {
      ok: false,
      deviceTag: input.deviceTag,
      error: `Ambiguous device: ${input.deviceTag}`,
      matches
    };
  }

  const mode = input.mode ?? "replace";
  const nextNote = input.note?.trim() ?? "";

  if (mode !== "clear" && nextNote.length === 0) {
    return {
      ok: false,
      device: matches[0],
      error: "note is required unless mode is clear."
    };
  }

  const device = matches[0];
  const featureCache = await readDeviceFeatureCache();
  const previous = featureCache[device.uid] ?? emptyCachedDeviceFeatures();
  const previousNote = previous.deviceNote;
  const deviceNote =
    mode === "clear"
      ? ""
      : mode === "append" && previousNote
        ? `${previousNote}\n${nextNote}`
        : nextNote;

  featureCache[device.uid] = {
    ...previous,
    deviceNote
  };
  await saveDeviceFeatureCache(featureCache);

  return {
    ok: true,
    device,
    mode,
    previousNote,
    deviceNote,
    featureCachePath: deviceFeatureCachePath
  };
}

export const setDeviceNoteTool = defineTool<SetDeviceNoteInput>({
  name: "set_device_note",
  title: "Set Device Note",
  description:
    "Add, replace, append, or clear a persistent note for one cached micrOS device. Notes are stored beside discovered features and survive rediscovery.",
  inputSchema: {
    deviceTag: z.string().min(1).describe("Device UID, FUID, IP address, or unambiguous partial name."),
    note: z
      .string()
      .optional()
      .describe("Note text about location, peripherals, command interpretation, wiring, or usage context."),
    mode: z
      .enum(["replace", "append", "clear"])
      .optional()
      .describe("How to update the note. Defaults to replace.")
  },
  handler: setDeviceNote
});
