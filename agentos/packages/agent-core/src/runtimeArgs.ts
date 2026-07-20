export function replaceOrAppendArg(args: string[], flag: string, value: string): string[] {
  const result: string[] = [];
  let replaced = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== flag) {
      result.push(args[index]);
      continue;
    }
    if (!replaced) {
      result.push(flag, value);
      replaced = true;
    }
    if (index + 1 < args.length) index += 1;
  }
  if (!replaced) result.push(flag, value);
  return result;
}

export function removeArgPair(args: string[], flag: string): string[] {
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === flag) {
      if (index + 1 < args.length) index += 1;
      continue;
    }
    result.push(args[index]);
  }
  return result;
}

export function replaceConfigArg(args: string[], key: string, value: string): string[] {
  const assignment = `${key}=${value}`;
  const result: string[] = [];
  let replaced = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== '-c') {
      result.push(args[index]);
      continue;
    }
    const configValue = args[index + 1];
    if (typeof configValue !== 'string' || !configValue.startsWith(`${key}=`)) {
      result.push(args[index]);
      continue;
    }
    if (!replaced) {
      result.push('-c', assignment);
      replaced = true;
    }
    index += 1;
  }
  if (!replaced) result.push('-c', assignment);
  return result;
}
