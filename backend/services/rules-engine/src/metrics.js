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

export function asPrometheus(namespace = "rules_engine") {
  return Object.entries(counters)
    .map(([key, value]) => {
      const [name, labelJson] = key.split(":");
      const labels = JSON.parse(labelJson || "{}");
      const labelStr =
        Object.keys(labels).length === 0
          ? ""
          : `{${Object.entries(labels)
              .map(([k, v]) => `${k}="${v}"`)
              .join(",")}}`;
      return `${namespace}_${name}${labelStr} ${value}`;
    })
    .join("\n");
}
