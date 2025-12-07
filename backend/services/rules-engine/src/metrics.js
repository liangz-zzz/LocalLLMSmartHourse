let counters = {};

export function incCounter(name, labels = {}) {
  const key = `${name}:${JSON.stringify(labels)}`;
  counters[key] = (counters[key] || 0) + 1;
}

export function snapshot() {
  return { counters: { ...counters } };
}

export function reset() {
  counters = {};
}
