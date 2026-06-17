import { z } from "zod";
import {
  cacheToDevices,
  deviceFeatureCachePath,
  deviceNotesCachePath,
  deviceNoteKey,
  findDevices,
  readDeviceCache,
  readDeviceFeatureCache,
  readDeviceNotesCache,
  saveDeviceNotesCache
} from "./common.js";
import { defineTool } from "../tool-definition.js";

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
  const noteKey = deviceNoteKey(device);
  const notesCache = await readDeviceNotesCache();
  const featureCache = await readDeviceFeatureCache();
  const previousNote = notesCache[noteKey] ?? notesCache[device.uid] ?? featureCache[device.uid]?.deviceNote ?? "";
  const deviceNote =
    mode === "clear"
      ? ""
      : mode === "append" && previousNote
        ? `${previousNote}\n${nextNote}`
        : nextNote;

  notesCache[noteKey] = deviceNote;
  delete notesCache[device.uid];
  await saveDeviceNotesCache(notesCache);

  return {
    ok: true,
    device,
    mode,
    previousNote,
    deviceNote,
    featureCachePath: deviceFeatureCachePath,
    notesCachePath: deviceNotesCachePath
  };
}

export const setDeviceNoteTool = defineTool<SetDeviceNoteInput>(import.meta.url, {
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
