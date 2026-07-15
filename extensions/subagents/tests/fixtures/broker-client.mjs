import * as net from "node:net";

const socketPath = process.argv[2];
if (!socketPath) {
  process.stderr.write("missing broker socket path\n");
  process.exit(2);
}

const socket = net.createConnection(socketPath);
socket.on("connect", () => process.stdout.write("READY\n"));
socket.on("data", () => undefined);
socket.on("close", () => process.exit(0));
socket.on("error", (error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});

process.on("SIGTERM", () => socket.destroy());
