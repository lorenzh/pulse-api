// Trivial check target of the bench stack: answers 200 "ok" on every path.
Bun.serve({ port: 8080, hostname: "0.0.0.0", fetch: () => new Response("ok") });
