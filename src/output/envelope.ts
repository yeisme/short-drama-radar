// --json envelope: stable machine surface, per ai-native-cli-output-contract.
export interface Envelope<T> {
  ok: boolean;
  app: "short-drama-radar";
  command: string;
  data: T;
  errors: string[];
}

export function envelope<T>(command: string, data: T, errors: string[] = []): Envelope<T> {
  return { ok: errors.length === 0, app: "short-drama-radar", command, data, errors };
}
