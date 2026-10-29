// Demo targets: one HTTP server whose answer depends on the path and on the time since start.
import { createServer } from "node:http";

const startedAt = Date.now();
const SLOW_DELAY_MS = 1500; // above the check's latencyObjectiveMs (500), below its timeoutMs (3000)
const FLAKY_FROM_MS = 30_000;
const FLAKY_UNTIL_MS = 150_000;

const server = createServer((req, res) => {
  const elapsed = Date.now() - startedAt;
  const reply = (status) => {
    res.writeHead(status, { "content-type": "text/plain" });
    res.end(status === 200 ? "ok\n" : "error\n");
  };
  switch (req.url) {
    case "/up":
      reply(200);
      break;
    case "/slow":
      setTimeout(() => reply(200), SLOW_DELAY_MS);
      break;
    case "/flaky":
      reply(elapsed >= FLAKY_FROM_MS && elapsed < FLAKY_UNTIL_MS ? 500 : 200);
      break;
    case "/maintenance":
      reply(500);
      break;
    default:
      res.writeHead(404);
      res.end();
  }
});

server.listen(8000, () => console.log("demo-targets listening on :8000"));
