import { z } from "zod";
import {
  cacheToDevices,
  type DiscoveredModule,
  MicrOSSocketClient,
  normalizeCommandPipeline,
  readDeviceCache,
  readDeviceFeatureCache,
  selectDevice,
  socketErrorMessage
} from "./common.js";
import { defineTool } from "../tool-definition.js";
import { documentModules, type DocumentedModule } from "../function-docs.js";

export type RunCommandInput = {
  deviceTag: string;
  command: string | string[];
  separator?: string;
  timeout?: number;
  password?: string;
  verbose?: boolean;
};

export type CommandModuleHint = {
  matchedCommands: string[];
  modules: DocumentedModule[];
};

export type CommandDenial = {
  rule: string;
  reason: string;
  command: string;
};

type CommandDenyRule = {
  name: string;
  check: (commands: string[]) => CommandDenial | undefined;
};

function commandWords(command: string) {
  return command.trim().split(/\s+/).filter(Boolean);
}

const commandDenyRules: CommandDenyRule[] = [
  {
    name: "conf-write",
    check(commands) {
      for (const command of commands) {
        const words = commandWords(command);
        if (words[0]?.toLowerCase() === "conf" && words.length >= 3) {
          return {
            rule: "conf-write",
            reason: "Configuration writes are not allowed.",
            command
          };
        }
      }

      if (commands[0]?.trim().toLowerCase() === "conf") {
        const valueWords = commands.slice(1).flatMap(commandWords);
        if (valueWords.length >= 2) {
          return {
            rule: "conf-write",
            reason: "Configuration writes are not allowed.",
            command: commands.join(" <a> ")
          };
        }
      }

      return undefined;
    }
  }
];

export function checkCommandPipeline(command: string | string[], separator = "<a>") {
  const commands = normalizeCommandPipeline(command, separator);
  const denial = commandDenyRules.map((rule) => rule.check(commands)).find(Boolean);
  return { commands, denial };
}

function firstCommandWord(command: string) {
  return command.trim().split(/\s+/, 1)[0] ?? "";
}

export async function buildCommandModuleHint(
  commands: string[],
  modules: DiscoveredModule[]
): Promise<CommandModuleHint | undefined> {
  const modulesByName = new Map(modules.map((module) => [module.name.toLowerCase(), module]));
  const firstCommand = commands[0];
  const module = firstCommand ? modulesByName.get(firstCommandWord(firstCommand).toLowerCase()) : undefined;

  if (!firstCommand || !module) {
    return undefined;
  }

  return {
    matchedCommands: [firstCommand],
    modules: await documentModules([module])
  };
}

export async function runCommand(input: RunCommandInput) {
  const { commands, denial } = checkCommandPipeline(input.command, input.separator);

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

  if (denial) {
    return {
      ok: false,
      error: `Command denied: ${denial.reason}`,
      rule: denial.rule,
      deniedCommand: denial.command,
      commands
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

  const featureCache = await readDeviceFeatureCache();
  const moduleHint = await buildCommandModuleHint(commands, featureCache[device.uid]?.modules ?? []);
  const responseContext = {
    device,
    commands,
    ...(moduleHint ? { moduleHint } : {})
  };

  const client = new MicrOSSocketClient(device, input.timeout ?? 10, input.password, Boolean(input.verbose));

  try {
    const replies = await client.runPipeline(commands);

    return {
      ok: true,
      ...responseContext,
      replies,
      output: replies.map((reply) => reply.join("\n").trim()).filter(Boolean).join("\n")
    };
  } catch (error) {
    return {
      ok: false,
      ...responseContext,
      error: socketErrorMessage(error)
    };
  } finally {
    client.close();
  }
}

export const runCommandTool = defineTool<RunCommandInput>(import.meta.url, {
  inputSchema: {
    deviceTag: z.string().describe("The exact micrOS device UID, device name, or IP address to target."),
    command: z
      .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
      .describe(
        "The command or command pipeline to run. String commands may use the <a> separator. Unsafe command forms are denied before connecting to a device."
      ),
    separator: z.string().optional().describe("Optional string command separator. Defaults to <a>."),
    timeout: z.number().int().positive().default(10).describe("Socket timeout in seconds. Defaults to 10."),
    password: z.string().optional().describe("Optional micrOS app password if auth is enabled."),
    verbose: z.boolean().optional().describe("Enable verbose micrOS client logging.")
  },
  handler: runCommand
});
