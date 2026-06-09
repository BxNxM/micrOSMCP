import {
  cacheToDevices,
  MicrOSSocketClient,
  normalizeCommandPipeline,
  readDeviceCache,
  type RunCommandInput,
  selectDevice,
  socketErrorMessage
} from "./common.js";

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
