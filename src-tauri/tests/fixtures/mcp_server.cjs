const readline = require("node:readline");

const lines = readline.createInterface({ input: process.stdin, terminal: false });

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

lines.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "levelup-fixture", version: "1.0.0" },
      },
    });
  } else if (message.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        tools: [
          {
            name: "echo",
            description: "Echo a value from the integration fixture.",
            inputSchema: {
              type: "object",
              properties: { value: { type: "string" } },
              required: ["value"],
            },
          },
        ],
      },
    });
  } else if (message.method === "tools/call") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        content: [{ type: "text", text: `echo:${message.params.arguments.value}` }],
        isError: false,
      },
    });
  }
});
