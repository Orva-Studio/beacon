#!/usr/bin/env bun
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { appCoreFor, appProjects, CONTROL_SOCKET, LocalCore, serveControl } from "@beacon/core";
import { createServer } from "./server";
import pkg from "../package.json";

// stdout carries the protocol; anything else printed there corrupts it.
console.log = console.error;
console.info = console.error;

// The control socket in each lock lets the app ask for a project the user wants to open there.
const core = new LocalCore({ name: "an agent's MCP server", control: CONTROL_SOCKET });
const server = createServer(core, pkg.version, { appCore: appCoreFor, appProjects });
const control = serveControl({ letGo: server.letGo });
const exit = () => {
  control.stop();
  core.closeAll();
  process.exit(0);
};
process.on("SIGINT", exit);
process.on("SIGTERM", exit);
process.stdin.on("end", exit);
await server.connect(new StdioServerTransport());
