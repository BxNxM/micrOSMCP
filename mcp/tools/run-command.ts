import { z } from "zod";
import {
  cacheToDevices,
  MicrOSSocketClient,
  normalizeCommandPipeline,
  readDeviceCache,
  selectDevice,
  socketErrorMessage
} from "./common.js";
import { defineTool } from "./definition.js";

export type RunCommandInput = {
  deviceTag: string;
  command: string | string[];
  separator?: string;
  timeout?: number;
  password?: string;
  verbose?: boolean;
};

export async function runCommand(input: RunCommandInput) {
  const commands = normalizeCommandPipeline(input.command, input.separator);

  if (input.deviceTag.trim().length === 0) {
    return {
      ok: false,
      error: "deviceTag is required."
    };
  }

  if (commands.length === 0) {
    return {
      ok: false,
      error: "command is required."
    };
  }

  const cache = await readDeviceCache();
  const device = selectDevice(cacheToDevices(cache), input.deviceTag);

  if (!device) {
    return {
      ok: false,
      error: `Unknown device: ${input.deviceTag}`
    };
  }

  const client = new MicrOSSocketClient(device, input.timeout ?? 10, input.password, Boolean(input.verbose));

  try {
    const replies = await client.runPipeline(commands);

    return {
      ok: true,
      device,
      commands,
      replies,
      output: replies.map((reply) => reply.join("\n").trim()).filter(Boolean).join("\n")
    };
  } catch (error) {
    return {
      ok: false,
      device,
      commands,
      error: socketErrorMessage(error)
    };
  } finally {
    client.close();
  }
}

export const runCommandTool = defineTool<RunCommandInput>({
  name: "run_command",
  title: "Run Command",
  description:
    "Run a real micrOS command pipeline on one selected embedded device. Use filter_devices first when choosing a target; commands may change device state.",
  inputSchema: {
    deviceTag: z.string().describe("The exact micrOS device UID, FUID, or IP address to target."),
    command: z
      .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
      .describe("The command or command pipeline to run. String commands may use the <a> separator."),
    separator: z.string().optional().describe("Optional string command separator. Defaults to <a>."),
    timeout: z.number().int().positive().optional().describe("Socket timeout in seconds. Defaults to 10."),
    password: z.string().optional().describe("Optional micrOS app password if auth is enabled."),
    verbose: z.boolean().optional().describe("Enable verbose micrOS client logging.")
  },
  handler: runCommand
});
