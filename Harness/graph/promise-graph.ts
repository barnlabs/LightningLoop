export interface PromiseGraphNode {
  id: string;
  duty: string;
  requires: readonly string[];
  provides: readonly string[];
  maxVisits: number;
  transitions: Readonly<Record<string, string | null>>;
}

export interface PromiseGraphTraceEntry {
  nodeID: string;
  duty: string;
  visit: number;
  route: string;
  provided: string[];
  evidence: string[];
}

export interface PromiseGraphContext {
  readonly promises: ReadonlyMap<string, unknown>;
  readonly visit: number;
  readonly step: number;
}

export interface PromiseGraphOutcome {
  route: string;
  promises?: Readonly<Record<string, unknown>>;
  evidence?: readonly string[];
}

export type PromiseGraphHandler = (context: PromiseGraphContext) => Promise<PromiseGraphOutcome>;

export interface PromiseGraphDefinition {
  id: string;
  entry: string;
  maxSteps: number;
  nodes: readonly PromiseGraphNode[];
}

export interface PromiseGraphResult {
  terminalRoute: string;
  promises: ReadonlyMap<string, unknown>;
  trace: PromiseGraphTraceEntry[];
}

const SAFE_ID = /^[a-z][a-z0-9_.-]{0,79}$/;

function clonePromiseValue(name: string, value: unknown): unknown {
  try {
    return structuredClone(value);
  } catch {
    throw new Error(`Promise ${name} must be structured-cloneable.`);
  }
}


export class PromiseGraph {
  private readonly nodes: Map<string, PromiseGraphNode>;
  private readonly graphID: string;
  private readonly entry: string;
  private readonly maxSteps: number;

  constructor(definition: PromiseGraphDefinition) {
    if (!SAFE_ID.test(definition.id)) throw new Error("Graph ID is invalid.");
    if (!Number.isInteger(definition.maxSteps) || definition.maxSteps < 1 || definition.maxSteps > 128) {
      throw new Error("Graph maxSteps must be an integer from 1 through 128.");
    }
    if (definition.nodes.length < 1 || definition.nodes.length > 64) throw new Error("A graph must contain 1-64 nodes.");
    this.nodes = new Map();
    for (const node of definition.nodes) {
      if (!SAFE_ID.test(node.id) || this.nodes.has(node.id)) throw new Error(`Graph node ID is invalid or duplicated: ${node.id}`);
      if (!node.duty.trim() || node.duty.length > 500) throw new Error(`Node ${node.id} must declare a bounded duty.`);
      if (!Number.isInteger(node.maxVisits) || node.maxVisits < 1 || node.maxVisits > 32) throw new Error(`Node ${node.id} maxVisits is invalid.`);
      for (const promise of [...node.requires, ...node.provides]) {
        if (!SAFE_ID.test(promise)) throw new Error(`Node ${node.id} contains an invalid promise name.`);
      }
      if (Object.keys(node.transitions).length < 1) throw new Error(`Node ${node.id} must declare at least one route.`);
      this.nodes.set(node.id, Object.freeze({
        ...node,
        requires: Object.freeze([...node.requires]),
        provides: Object.freeze([...node.provides]),
        transitions: Object.freeze({ ...node.transitions }),
      }));
    }
    if (!this.nodes.has(definition.entry)) throw new Error("Graph entry node does not exist.");
    for (const node of definition.nodes) {
      for (const target of Object.values(node.transitions)) {
        if (target !== null && !this.nodes.has(target)) throw new Error(`Node ${node.id} targets missing node ${target}.`);
      }
    }
    this.graphID = definition.id;
    this.entry = definition.entry;
    this.maxSteps = definition.maxSteps;
  }

  async run(initial: Readonly<Record<string, unknown>>, handlers: Readonly<Record<string, PromiseGraphHandler>>): Promise<PromiseGraphResult> {
    const promises = new Map(Object.entries(initial).map(([name, value]) => {
      if (!SAFE_ID.test(name)) throw new Error(`Initial promise name is invalid: ${name}`);
      if (value === undefined) throw new Error(`Initial promise ${name} cannot be undefined.`);
      return [name, clonePromiseValue(name, value)];
    }));
    const visits = new Map<string, number>();
    const trace: PromiseGraphTraceEntry[] = [];
    let currentID = this.entry;
    for (let step = 1; step <= this.maxSteps; step += 1) {
      const node = this.nodes.get(currentID)!;
      const visit = (visits.get(currentID) ?? 0) + 1;
      if (visit > node.maxVisits) throw new Error(`Graph ${this.graphID} exceeded the visit bound for ${currentID}.`);
      visits.set(currentID, visit);
      const missing = node.requires.filter((name) => !promises.has(name));
      if (missing.length > 0) throw new Error(`Node ${currentID} is blocked on promises: ${missing.join(", ")}.`);
      const handler = handlers[currentID];
      if (!handler) throw new Error(`Graph handler is missing for ${currentID}.`);
      // A handler receives a cloned snapshot, never state it can mutate to forge
      // a downstream promise. Promise values are data commitments, not shared state.
      const snapshot = new Map([...promises].map(([name, value]) => [name, clonePromiseValue(name, value)]));
      const outcome = await handler({ promises: snapshot, visit, step });
      // Snapshot every handler-controlled field exactly once. Validation, commit,
      // and trace all consume this ordinary data so a Proxy/getter cannot change
      // the outcome between the check and the write.
      const route = outcome.route;
      const promiseEntries = Object.entries(outcome.promises ?? {}).map(([name, value]) => [name, clonePromiseValue(name, value)] as const);
      const provided = promiseEntries.map(([name]) => name);
      const evidence = [...(outcome.evidence ?? [])].slice(0, 20).map((item) => String(item).slice(0, 2_000));
      if (!Object.hasOwn(node.transitions, route)) throw new Error(`Node ${currentID} returned undeclared route ${route}.`);
      const undeclared = provided.filter((name) => !node.provides.includes(name));
      if (undeclared.length > 0) throw new Error(`Node ${currentID} attempted to provide undeclared promises: ${undeclared.join(", ")}.`);
      const target = node.transitions[route];
      const omitted = node.provides.filter((name) => !provided.includes(name));
      if (omitted.length > 0) {
        const nodeKind = target === null ? "Terminal node" : "Node";
        throw new Error(`${nodeKind} ${currentID} omitted declared promises: ${omitted.join(", ")}.`);
      }
      for (const [name, value] of promiseEntries) {
        if (value === undefined) throw new Error(`Node ${currentID} cannot fulfill promise ${name} with undefined.`);
        promises.set(name, value);
      }
      trace.push({ nodeID: currentID, duty: node.duty, visit, route, provided, evidence });
      if (target === null) {
        return {
          terminalRoute: route,
          promises: new Map([...promises].map(([name, value]) => [name, clonePromiseValue(name, value)])),
          trace: structuredClone(trace),
        };
      }
      if (target === undefined) throw new Error(`Node ${currentID} returned an unresolved route.`);
      currentID = target;
    }
    throw new Error(`Graph ${this.graphID} exceeded its total step bound.`);
  }
}
