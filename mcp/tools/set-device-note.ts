import { z } from "zod";
import {
  cacheToDevices,
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
  mode?: "replace" | "append";
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
  const device = matches[0];
  const noteKey = deviceNoteKey(device);
  const notesCache = await readDeviceNotesCache();
  const featureCache = await readDeviceFeatureCache();
  const previousNote = notesCache[noteKey] ?? notesCache[device.uid] ?? featureCache[device.uid]?.deviceNote ?? "";

  if (nextNote.length === 0) {
    return {
      ok: true,
      device,
      mode: "read",
      deviceNote: previousNote
    };
  }

  const deviceNote = mode === "append" && previousNote ? `${previousNote}\n${nextNote}` : nextNote;

  notesCache[noteKey] = deviceNote;
  delete notesCache[device.uid];
  await saveDeviceNotesCache(notesCache);

  return {
    ok: true,
    device,
    mode,
    previousNote,
    deviceNote
  };
}

export const setDeviceNoteTool = defineTool<SetDeviceNoteInput>(import.meta.url, {
  inputSchema: {
    deviceTag: z.string().min(1).describe("Device UID, IP address, or unambiguous partial device name."),
    note: z
      .string()
      .optional()
      .describe("Note text to store. Omit or send an empty value to return the current note without changing it."),
    mode: z
      .enum(["replace", "append"])
      .default("replace")
      .describe("How to update the note. Defaults to replace.")
  },
  handler: setDeviceNote
});
