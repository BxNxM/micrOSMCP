import { discoverCommandsTool } from "./discover-commands.js";
import { discoverDevicesTool } from "./discover-devices.js";
import { filterDevicesTool } from "./filter-devices.js";
import { listDevicesTool } from "./list-devices.js";
import { runCommandTool } from "./run-command.js";

export const toolDefinitions = [
  listDevicesTool,
  filterDevicesTool,
  discoverDevicesTool,
  runCommandTool,
  discoverCommandsTool
];
