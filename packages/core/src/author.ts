import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Who is making the changes in this call: an agent, by the name its MCP client gives ("claude-code"), set by the MCP
 * server round each tool call and by the automation socket round each request that carries one; outside any, the user.
 * Every undo step records it, so ⌘Z can skip the agents' steps.
 */
export const authorContext = new AsyncLocalStorage<string>();
export const currentAuthor = () => authorContext.getStore();
export const asAuthor = <T>(author: string | undefined, fn: () => T): T => (author === undefined ? fn() : authorContext.run(author, fn));
