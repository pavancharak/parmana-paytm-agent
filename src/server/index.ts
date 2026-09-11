import http from "node:http";
import { config, requestHandler } from "./handler.js";

/**
 * Local/long-lived server entrypoint (`npm start`). Vercel's deployment
 * uses api/index.ts instead, which imports the same requestHandler
 * without calling .listen() -- see that file's own comment.
 */
export const server = http.createServer(requestHandler);

if (process.env.NODE_ENV !== "test") {
  server.listen(config.port, "0.0.0.0", () => console.log(`parmana-paytm-agent listening on ${config.port}`));
}
