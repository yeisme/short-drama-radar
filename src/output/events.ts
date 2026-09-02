// --events NDJSON stream for long tasks (collect, run). Every line carries an
// incrementing seq and the run_id; the stream always terminates with a final
// `end` or `error` event, and the process exit code mirrors the outcome.

export interface StreamEvent {
  seq: number;
  run_id: string;
  event: string; // start | layer | item | end | error
  ts: string;
  [key: string]: unknown;
}

export class EventWriter {
  private seq = 0;

  constructor(
    private readonly runId: string,
    private readonly write: (line: string) => void = (l) => console.log(l),
  ) {}

  emit(event: Omit<StreamEvent, "seq" | "run_id" | "ts">): void {
    this.seq++;
    this.write(JSON.stringify({ seq: this.seq, run_id: this.runId, ts: new Date().toISOString(), ...event }));
  }

  start(command: string, facts: Record<string, unknown> = {}): void {
    this.emit({ event: "start", command, ...facts });
  }

  layer(source: string, degraded: boolean, items: number, errors: string[] = []): void {
    this.emit({ event: "layer", source, degraded, items, ...(errors.length > 0 ? { errors } : {}) });
  }

  item(contentId: string, platform: string, score?: number): void {
    this.emit({ event: "item", content_id: contentId, platform, ...(typeof score === "number" ? { score } : {}) });
  }

  end(status: string, facts: Record<string, unknown> = {}): void {
    this.emit({ event: "end", status, ...facts });
  }

  error(code: string, message: string): void {
    this.emit({ event: "error", code, message });
  }
}
