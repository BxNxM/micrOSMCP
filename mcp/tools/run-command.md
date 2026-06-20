Run a micrOS command or a sequential command pipeline on one live device. Before using this tool, call `search_devices` to confirm the exact device and relevant command signature. Target the device by its exact UID, device name, or IP address.

Command syntax examples:

- No arguments: `version`
- Positional argument: `conf webui`
- Module function: `dht22 measure`
- Keyword argument: `dht22 measure log=True`
- String pipeline: `rgb status <a> dht22 measure`
- Array pipeline: `["version", "dht22 measure"]`

For a string pipeline, `<a>` separates commands by default; `separator` can select a different delimiter. For an array pipeline, each array item is one command and runs in order.

Commands act on a real device and may change its state. Configuration reads such as `conf` and `conf webui` are allowed, but configuration writes such as `conf webui true` are rejected. Other commands are not automatically made safe, so use the least disruptive command that fulfills the request.
