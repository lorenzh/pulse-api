// Self-test of the load generator's handling of a connection closed before any response.
import assert from "node:assert/strict";
import { createServer, type Socket } from "node:net";
import {
  drain,
  isClosedBeforeResponse,
  MAX_CONNECTION_RESETS,
  type Resets,
  timed,
} from "../load.ts";

/** A server that closes its first connection without a response and answers 200 on later ones. */
async function closeFirstServer(): Promise<{
  url: string;
  connections: () => number;
  close: () => void;
}> {
  let connections = 0;
  const server = createServer((socket: Socket) => {
    connections += 1;
    if (connections === 1) {
      socket.once("data", () => socket.destroy());
      return;
    }
    socket.on("data", () =>
      socket.end("HTTP/1.1 200 OK\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}/`,
    connections: () => connections,
    close: () => server.close(),
  };
}

const get = await closeFirstServer();
const getResets: Resets = { retriedGets: 0, droppedPosts: 0 };
const getSamples: number[] = [];
await timed(get.url, {}, 200, getSamples, getResets);
assert.deepEqual(getResets, { retriedGets: 1, droppedPosts: 0 });
assert.equal(getSamples.length, 1);
assert.equal(get.connections(), 2);
get.close();

const post = await closeFirstServer();
const postResets: Resets = { retriedGets: 0, droppedPosts: 0 };
const postSamples: number[] = [];
await timed(post.url, { method: "POST", body: "{}" }, 204, postSamples, postResets);
// A POST is never sent twice: a repeated result would be stored twice.
assert.deepEqual(postResets, { retriedGets: 0, droppedPosts: 1 });
assert.equal(postSamples.length, 0);
assert.equal(post.connections(), 1);
post.close();

// Any other failure still fails the run.
const refused: Resets = { retriedGets: 0, droppedPosts: 0 };
await assert.rejects(
  timed("http://127.0.0.1:1/", {}, 200, undefined, refused),
  /GET http:\/\/127\.0\.0\.1:1\/ after/,
);
assert.deepEqual(refused, { retriedGets: 0, droppedPosts: 0 });
assert.equal(isClosedBeforeResponse(new Error("other")), false);
// Resets that arrive while the last requests drain count against the cap too.
const slow = createServer((socket: Socket) => {
  socket.once("data", () => setTimeout(() => socket.destroy(), 100));
});
await new Promise<void>((resolve) => slow.listen(0, "127.0.0.1", resolve));
const slowUrl = `http://127.0.0.1:${(slow.address() as { port: number }).port}/`;
const slowPost = (resets: Resets): Promise<void> =>
  timed(slowUrl, { method: "POST", body: "{}" }, 204, undefined, resets);
const tooMany: Resets = { retriedGets: 0, droppedPosts: 0 };
const late = Array.from({ length: MAX_CONNECTION_RESETS * 2 }, () => slowPost(tooMany));
assert.equal(tooMany.droppedPosts, 0);
await assert.rejects(drain(late, tooMany), /more than 5 connections closed before a response/);
assert.equal(tooMany.droppedPosts, MAX_CONNECTION_RESETS * 2);
const few: Resets = { retriedGets: 0, droppedPosts: 0 };
await drain(
  Array.from({ length: MAX_CONNECTION_RESETS }, () => slowPost(few)),
  few,
);
assert.equal(few.droppedPosts, MAX_CONNECTION_RESETS);
slow.close();
console.log("check-load: ok");
