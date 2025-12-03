#!/usr/bin/env node
import mqtt from "mqtt";

function parseArg(flag, fallback) {
  const idx = process.argv.indexOf(flag);
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

const url = parseArg("--url", process.env.MQTT_URL || "mqtt://localhost:1883");
const topic = parseArg("--topic", process.env.MQTT_TOPIC || "zigbee2mqtt/#");
const quiet = process.argv.includes("--quiet");

const client = mqtt.connect(url);

client.on("connect", () => {
  console.log(`[mqtt-dump] connected to ${url}, subscribing ${topic}`);
  client.subscribe(topic);
});

client.on("message", (t, payload) => {
  const body = payload.toString();
  const ts = new Date().toISOString();
  if (quiet) {
    console.log(body);
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (_err) {
    parsed = body;
  }
  console.log(`[${ts}] ${t}`);
  console.dir(parsed, { depth: 4, colors: true });
});

client.on("error", (err) => {
  console.error("[mqtt-dump] error", err);
  process.exit(1);
});
