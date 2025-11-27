export function evaluateRules(event, rules, publishAction) {
  const matched = [];
  for (const rule of rules) {
    if (!rule.when || !rule.then) continue;
    if (rule.when.deviceId && rule.when.deviceId !== event.id) continue;
    const value = getPath(event, rule.when.traitPath || "");
    if (rule.when.equals !== undefined && value !== rule.when.equals) continue;
    matched.push(rule.id);
    publishAction({
      id: event.id,
      action: rule.then.action,
      params: rule.then.params || {},
      ruleId: rule.id
    });
  }
  return matched;
}

function getPath(obj, path) {
  if (!path) return undefined;
  return path.split(".").reduce((acc, key) => (acc ? acc[key] : undefined), obj);
}
