#!/usr/bin/env bun
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { appCoreFor, appProjects, LocalCore } from "@beacon/core";
import { createServer } from "./server";
import pkg from "../package.json";

// stdout carries the protocol; anything else printed there corrupts it.
console.log = console.error;
console.info = console.error;

const core = new LocalCore();
const server = createServer(core, pkg.version, { appCore: appCoreFor, appProjects });
const exit = () => {
  core.closeAll();
  process.exit(0);
};
process.on("SIGINT", exit);
process.on("SIGTERM", exit);
process.stdin.on("end", exit);
await server.connect(new StdioServerTransport());
