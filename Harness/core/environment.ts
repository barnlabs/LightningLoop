const SENSITIVE_NAME = /(?:^|_)(?:API_?KEY|AUTH|CREDENTIAL|PASSWORD|PRIVATE_?KEY|SECRET|TOKEN)(?:_|$)/i;
const SENSITIVE_VALUE = /(?:\bBearer\s+|\bcsk-|\bfc-|:\/\/[^\s/:]+:[^\s/@]+@)/i;

export function scrubSensitiveEnvironment(environment: NodeJS.ProcessEnv): string[] {
  const removed: string[] = [];
  for (const [name, value] of Object.entries(environment)) {
    if (SENSITIVE_NAME.test(name) || (value !== undefined && SENSITIVE_VALUE.test(value))) {
      delete environment[name];
      removed.push(name);
    }
  }
  return removed.sort();
}
