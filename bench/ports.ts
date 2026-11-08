// Host ports of a bench stack: blocks of five ports in 20000-29999, outside the ephemeral range.
import { createServer, type Server } from "node:net";

const FIRST_PORT = 20_000;
const BLOCK_SIZE = 5;
const BLOCK_COUNT = 2000;
const RANGE_TEXT = "20000-29999";

class PortAllocationError extends Error {
  override readonly name = "PortAllocationError";
}

/** The host's ephemeral port range (`/proc/sys/net/ipv4/ip_local_port_range`). */
export interface EphemeralRange {
  low: number;
  high: number;
}

export interface ServicePorts {
  api: number;
  probe: number;
  status: number;
  notify: number;
}

/** A reserved block: its guard port stays bound until `release`. */
export interface PortLease {
  block: number;
  ports: ServicePorts;
  release(): Promise<void>;
}

interface Listener {
  close(): Promise<void>;
}

interface AllocateDeps {
  /** Listens on 127.0.0.1:`port`; `null` when the port is in use. */
  listen(port: number): Promise<Listener | null>;
  /** A number in [0, 1). */
  random(): number;
}

function parsePort(text: string): number | undefined {
  if (!/^\d{1,5}$/.test(text)) return undefined;
  const port = Number(text);
  return port >= 1 && port <= 65_535 ? port : undefined;
}

/** Parses two whitespace-separated ports, low <= high. Anything else throws. */
export function parseEphemeralRange(text: string): EphemeralRange {
  const parts = text.trim().split(/\s+/);
  const low = parts.length === 2 ? parsePort(parts[0] ?? "") : undefined;
  const high = parts.length === 2 ? parsePort(parts[1] ?? "") : undefined;
  if (low === undefined || high === undefined || low > high) {
    throw new PortAllocationError(
      `invalid ephemeral port range ${JSON.stringify(text.slice(0, 40))}`,
    );
  }
  return { low, high };
}

const guardPort = (block: number): number => FIRST_PORT + BLOCK_SIZE * block;

/** The blocks whose five ports all lie outside `range`. Throws when there is none. */
export function candidateBlocks(range: EphemeralRange): number[] {
  const blocks: number[] = [];
  for (let block = 0; block < BLOCK_COUNT; block++) {
    const first = guardPort(block);
    const last = first + BLOCK_SIZE - 1;
    if (last < range.low || first > range.high) blocks.push(block);
  }
  if (blocks.length === 0) {
    throw new PortAllocationError(
      `no bench port block in ${RANGE_TEXT} outside the ephemeral range ${range.low}-${range.high}`,
    );
  }
  return blocks;
}

function servicePorts(block: number): ServicePorts {
  const guard = guardPort(block);
  return { api: guard + 1, probe: guard + 2, status: guard + 3, notify: guard + 4 };
}

async function areFree(deps: AllocateDeps, ports: ServicePorts): Promise<boolean> {
  for (const port of [ports.api, ports.probe, ports.status, ports.notify]) {
    const listener = await deps.listen(port);
    if (listener === null) return false;
    await listener.close();
  }
  return true;
}

async function tryBlock(deps: AllocateDeps, block: number): Promise<PortLease | undefined> {
  const guard = await deps.listen(guardPort(block));
  if (guard === null) return undefined;
  const ports = servicePorts(block);
  if (!(await areFree(deps, ports))) {
    await guard.close();
    return undefined;
  }
  return { block, ports, release: () => guard.close() };
}

/**
 * Reserves the first free block from a random start, scanning forward with wrap-around. Each
 * block is tried once; `exclude` holds blocks that failed before.
 */
export async function allocatePorts(
  deps: AllocateDeps,
  blocks: readonly number[],
  exclude: readonly number[],
): Promise<PortLease> {
  const start = Math.floor(deps.random() * blocks.length);
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[(start + i) % blocks.length];
    if (block === undefined || exclude.includes(block)) continue;
    const lease = await tryBlock(deps, block);
    if (lease !== undefined) return lease;
  }
  throw new PortAllocationError(`no free bench port block in ${RANGE_TEXT}`);
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

/** The real `listen`: a TCP listener on 127.0.0.1. */
export function listenLoopback(port: number): Promise<Listener | null> {
  return new Promise((resolve) => {
    const server = createServer();
    // Any listen error (in use, not permitted) means this port cannot serve the bench.
    server.once("error", () => resolve(null));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      resolve({ close: () => closeServer(server) });
    });
  });
}
