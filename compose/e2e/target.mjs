// Target of the e2e check "e2e-post". It answers 200 {"status":"ok"} only for the exact
// request the check sends. POST /mode/<name> switches the answer: ok, degraded, 503, text.
// It never logs headers or bodies.
import { createServer } from "node:http";

const token = process.env.PULSE_HEADER_SVC_TOKEN ?? "";
const expectedBody = '{"ping":"e2e-body-sentinel"}';
let mode = "ok";

createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    const url = req.url ?? "/";
    if (req.method === "POST" && url.startsWith("/mode/")) {
      mode = url.slice("/mode/".length);
      res.writeHead(204).end();
      return;
    }
    const isMatch =
      req.method === "POST" &&
      url === "/svc" &&
      token !== "" &&
      req.headers.authorization === `Bearer ${token}` &&
      req.headers["content-type"] === "application/json" &&
      body === expectedBody;
    if (!isMatch) {
      res.writeHead(400).end("bad request");
    } else if (mode === "503") {
      res.writeHead(503).end("unavailable");
    } else if (mode === "text") {
      res.writeHead(200, { "content-type": "text/plain" }).end("not json");
    } else {
      const status = mode === "degraded" ? "degraded" : "ok";
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ status }));
    }
  });
}).listen(8000, "0.0.0.0", () => console.log("e2e target listening on 8000"));
