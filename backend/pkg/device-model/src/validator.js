import { z } from "zod";

const placementSchema = z.object({
  room: z.string().min(1),
  zone: z.string().optional(),
  floor: z.string().optional(),
  mount: z.enum(["ceiling", "wall", "desktop", "window", "floor"]).optional(),
  description: z.string().optional(),
  coordinates: z
    .object({
      x: z.number().optional(),
      y: z.number().optional(),
      z: z.number().optional(),
      lat: z.number().optional(),
      lon: z.number().optional()
    })
    .partial()
    .optional()
});

const zigbeeBinding = z.object({
  topic: z.string().min(1),
  friendly_name: z.string().optional(),
  ieee_address: z.string().optional()
});

const voiceControlSlotSchema = z.object({
  type: z.enum(["boolean", "number", "string", "enum"]).optional(),
  minimum: z.number().optional(),
  maximum: z.number().optional(),
  enum: z.array(z.string()).optional(),
  required: z.boolean().optional()
});

const voiceControlActionSpec = z.object({
  utterances: z.array(z.string().min(1)).min(1),
  deterministic: z.boolean().optional(),
  slot_schema: z.record(z.string().min(1), voiceControlSlotSchema).optional(),
  pre_delay_ms: z.number().int().min(0).optional(),
  post_delay_ms: z.number().int().min(0).optional(),
  interrupt_phrases: z.array(z.string().min(1)).optional(),
  risk: z.enum(["low", "medium", "high"]).optional()
});

const voiceControlBinding = z.object({
  transport: z.enum(["local_tts"]).optional(),
  priority: z.enum(["prefer", "fallback"]).optional(),
  audio_output: z.string().optional(),
  preferred_mics: z.array(z.string().min(1)).optional(),
  wake: z.object({
    utterances: z.array(z.string().min(1)).min(1),
    retries: z.number().int().min(0).optional(),
    gap_ms: z.number().int().min(0).optional()
  }),
  ack: z
    .object({
      keywords: z.array(z.string().min(1)).optional(),
      timeout_ms: z.number().int().min(100).optional(),
      listen_window_ms: z.number().int().min(100).optional()
    })
    .optional(),
  actions: z.record(z.string().min(1), voiceControlActionSpec).refine((value) => Object.keys(value).length > 0, {
    message: "at least one voice action is required"
  })
});

const bindingsSchema = z.object({
  zigbee2mqtt: zigbeeBinding.optional(),
  ha_entity_id: z.string().optional(),
  ha: z
    .object({
      entity_id: z.string().min(1)
    })
    .optional(),
  voice_control: voiceControlBinding.optional(),
  vendor_extra: z.record(z.unknown()).optional()
});

const switchTrait = z.object({
  state: z.enum(["on", "off"]),
  power_w: z.number().optional(),
  energy_kwh: z.number().optional()
});

const dimmerTrait = z.object({
  state: z.enum(["on", "off"]),
  brightness: z.number().min(0).max(100).optional()
});

const climateTrait = z.object({
  mode: z.enum(["off", "heat", "cool", "auto", "dry", "fan_only"]),
  target_temperature_c: z.number().optional(),
  current_temperature_c: z.number().optional(),
  fan_mode: z.enum(["off", "low", "medium", "high", "auto"]).optional(),
  humidity_percent: z.number().optional()
});

const coverTrait = z.object({
  position_percent: z.number().min(0).max(100).optional(),
  state: z.enum(["opening", "closing", "stopped"]).optional()
});

const telemetryTrait = z.object({
  last_seen: z.string().optional(),
  battery_percent: z.number().optional(),
  linkquality: z.number().optional(),
  signal_dbm: z.number().optional()
});

const traitsSchema = z.object({
  switch: switchTrait.optional(),
  dimmer: dimmerTrait.optional(),
  climate: climateTrait.optional(),
  cover: coverTrait.optional(),
  telemetry: telemetryTrait.optional()
});

const capabilityParameter = z.object({
  name: z.string().min(1),
  type: z.enum(["boolean", "number", "string", "enum"]),
  minimum: z.number().optional(),
  maximum: z.number().optional(),
  enum: z.array(z.string()).optional(),
  required: z.boolean().optional(),
  description: z.string().optional()
});

const capabilitySchema = z.object({
  action: z.string().min(1),
  description: z.string().optional(),
  parameters: z.array(capabilityParameter).optional()
});

const semanticsSchema = z.object({
  summary: z.string().optional(),
  tags: z.array(z.string()).optional(),
  aliases: z.array(z.string()).optional(),
  preferred_scenes: z.array(z.string()).optional(),
  constraints: z.array(z.string()).optional(),
  owner_notes: z.string().optional(),
  description: z.string().optional(),
  vendor: z.string().optional(),
  model: z.string().optional()
});

export const deviceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  placement: placementSchema,
  protocol: z.enum(["zigbee", "wifi", "bluetooth_mesh", "matter", "virtual"]),
  bindings: bindingsSchema,
  traits: traitsSchema,
  capabilities: z.array(capabilitySchema),
  semantics: semanticsSchema.optional()
});

export function validateDevice(input) {
  const result = deviceSchema.safeParse(input);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return {
    success: false,
    errors: result.error.format()
  };
}

export function validateDevices(list) {
  const results = [];
  for (const item of list) {
    const res = validateDevice(item);
    results.push(res);
  }
  const failed = results.filter((r) => !r.success);
  return { success: failed.length === 0, results };
}
