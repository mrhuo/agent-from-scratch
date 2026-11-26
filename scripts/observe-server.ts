/**
 * 独立启动观测端点（不需要 API key）。
 *   npx tsx scripts/observe-server.ts [port]
 * 端点：/  /metrics  /traces  /traces/<traceId>  /healthz  /readyz
 */
import {
  defaultMetrics,
  InMemoryCollector,
  JsonlSpanExporter,
  Tracer,
  createObservabilityServer,
  listenObservabilityServer,
} from "../src/observe/index.js";
import { join } from "node:path";

const port = Number(process.argv[2] ?? 9464);
const collector = new InMemoryCollector();
const exporter = new JsonlSpanExporter(join(process.cwd(), "data", "traces.jsonl"));
const tracer = new Tracer(collector).addExporter(exporter);
const metrics = defaultMetrics();
void tracer;

const bound = await listenObservabilityServer(
  createObservabilityServer({ metrics: metrics.registry, collector }),
  port,
);

console.log(`观测端点已启动：${bound.url}`);
console.log(`  dashboard  ${bound.url}/`);
console.log(`  metrics    ${bound.url}/metrics`);
console.log(`  traces     ${bound.url}/traces`);
console.log(`按 Ctrl+C 退出`);
