/**
 * 最小 Prometheus 指标实现。
 *
 * 只支持四种生产环境最常用的形态：counter / histogram / gauge，
 * 加一个带标签的注册表。没有官方 client 依赖，输出是标准文本格式，
 * Prometheus / VictoriaMetrics 可直接抓取。
 *
 * 隐私边界：标签值只能是枚举出来的有限集合（status、tool 名、model 名）。
 * 用户输入、工具参数、模型答复一律不进指标——这些属于日志与追踪的范畴，
 * 且必须在采集端做脱敏。
 */

export type Labels = Record<string, string>;

function labelKey(labels: Labels): string {
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}=${labels[k] ?? ""}`)
    .join(",");
}

function escapeLabelValue(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function renderLabels(labels: Labels): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return "";
  return `{${keys.map((k) => `${k}="${escapeLabelValue(labels[k] ?? "")}"`).join(",")}}`;
}

export class Counter {
  private readonly values = new Map<string, { labels: Labels; value: number }>();

  constructor(
    readonly name: string,
    readonly help: string,
  ) {}

  inc(labels: Labels = {}, by = 1): void {
    const key = labelKey(labels);
    const entry = this.values.get(key) ?? { labels: { ...labels }, value: 0 };
    entry.value += by;
    this.values.set(key, entry);
  }

  /** 无标签的合计，供演示脚本打印 */
  total(): number {
    let sum = 0;
    for (const e of this.values.values()) sum += e.value;
    return sum;
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const { labels, value } of this.values.values()) {
      lines.push(`${this.name}${renderLabels(labels)} ${value}`);
    }
    return lines.join("\n");
  }
}

export const DEFAULT_BUCKETS = [10, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

export class Histogram {
  private readonly values = new Map<
    string,
    { labels: Labels; buckets: number[]; sum: number; count: number }
  >();

  constructor(
    readonly name: string,
    readonly help: string,
    readonly buckets: number[] = DEFAULT_BUCKETS,
  ) {}

  observe(ms: number, labels: Labels = {}): void {
    const key = labelKey(labels);
    const entry = this.values.get(key) ?? {
      labels: { ...labels },
      buckets: this.buckets.map(() => 0),
      sum: 0,
      count: 0,
    };
    entry.sum += ms;
    entry.count += 1;
    for (let i = 0; i < this.buckets.length; i++) {
      if (ms <= this.buckets[i]!) entry.buckets[i]! += 1;
    }
    this.values.set(key, entry);
  }

  snapshot(labels: Labels = {}): { count: number; sum: number } {
    const e = this.values.get(labelKey(labels));
    return e ? { count: e.count, sum: e.sum } : { count: 0, sum: 0 };
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const { labels, buckets, sum, count } of this.values.values()) {
      for (let i = 0; i < this.buckets.length; i++) {
        lines.push(
          `${this.name}_bucket${renderLabels({ ...labels, le: String(this.buckets[i]) })} ${buckets[i]}`,
        );
      }
      lines.push(`${this.name}_bucket${renderLabels({ ...labels, le: "+Inf" })} ${count}`);
      lines.push(`${this.name}_sum${renderLabels(labels)} ${sum}`);
      lines.push(`${this.name}_count${renderLabels(labels)} ${count}`);
    }
    return lines.join("\n");
  }
}

export class Gauge {
  private readonly values = new Map<string, { labels: Labels; value: number }>();

  constructor(
    readonly name: string,
    readonly help: string,
  ) {}

  inc(labels: Labels = {}, by = 1): void {
    this.set(labels, (this.get(labels) ?? 0) + by);
  }

  dec(labels: Labels = {}, by = 1): void {
    this.inc(labels, -by);
  }

  set(labels: Labels, value: number): void {
    this.values.set(labelKey(labels), { labels: { ...labels }, value });
  }

  get(labels: Labels = {}): number | undefined {
    return this.values.get(labelKey(labels))?.value;
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`];
    for (const { labels, value } of this.values.values()) {
      lines.push(`${this.name}${renderLabels(labels)} ${value}`);
    }
    return lines.join("\n");
  }
}

export class MetricsRegistry {
  readonly counters = new Map<string, Counter>();
  readonly histograms = new Map<string, Histogram>();
  readonly gauges = new Map<string, Gauge>();

  counter(name: string, help: string): Counter {
    let m = this.counters.get(name);
    if (!m) {
      m = new Counter(name, help);
      this.counters.set(name, m);
    }
    return m;
  }

  histogram(name: string, help: string, buckets?: number[]): Histogram {
    let m = this.histograms.get(name);
    if (!m) {
      m = new Histogram(name, help, buckets);
      this.histograms.set(name, m);
    }
    return m;
  }

  gauge(name: string, help: string): Gauge {
    let m = this.gauges.get(name);
    if (!m) {
      m = new Gauge(name, help);
      this.gauges.set(name, m);
    }
    return m;
  }

  render(): string {
    const blocks = [
      ...[...this.counters.values()].map((m) => m.render()),
      ...[...this.histograms.values()].map((m) => m.render()),
      ...[...this.gauges.values()].map((m) => m.render()),
    ];
    return `${blocks.join("\n")}\n`;
  }
}

/** 本篇使用的全部指标名集中定义，避免各处拼写漂移 */
export function defaultMetrics(): {
  registry: MetricsRegistry;
  requests: Counter;
  requestDuration: Histogram;
  queueDuration: Histogram;
  inFlight: Gauge;
  llmCalls: Counter;
  toolCalls: Counter;
  timeouts: Counter;
} {
  const registry = new MetricsRegistry();
  return {
    registry,
    requests: registry.counter("agent_requests_total", "Agent 请求数（按最终状态分类）"),
    requestDuration: registry.histogram(
      "agent_request_duration_ms",
      "Agent 单请求端到端耗时（毫秒）",
    ),
    queueDuration: registry.histogram(
      "agent_request_queue_ms",
      "请求在并发队列中的等待时间（毫秒）",
    ),
    inFlight: registry.gauge("agent_in_flight", "正在执行的请求数"),
    llmCalls: registry.counter("agent_llm_calls_total", "模型调用数（按状态分类）"),
    toolCalls: registry.counter("agent_tool_calls_total", "工具调用数（按工具与状态分类）"),
    timeouts: registry.counter("agent_timeouts_total", "超时/取消次数"),
  };
}
