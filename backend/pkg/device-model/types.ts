export type Protocol = "zigbee" | "wifi" | "bluetooth_mesh" | "matter" | "virtual";

export interface Placement {
  room: string;
  zone?: string;
  floor?: string;
  mount?: "ceiling" | "wall" | "desktop" | "window" | "floor";
  description?: string;
  coordinates?: { x?: number; y?: number; z?: number; lat?: number; lon?: number };
}

export interface Zigbee2MqttBinding {
  topic: string; // e.g. zigbee2mqtt/living_room_plug
  friendly_name?: string;
  ieee_address?: string;
}

export interface HABinding {
  entity_id: string; // e.g. switch.living_room_plug
}

export interface DeviceBindings {
  zigbee2mqtt?: Zigbee2MqttBinding;
  ha_entity_id?: string; // fallback string form
  ha?: HABinding;
  vendor_extra?: Record<string, unknown>;
}

export type SwitchState = "on" | "off";
export type FanMode = "off" | "low" | "medium" | "high" | "auto";
export type ClimateMode = "off" | "heat" | "cool" | "auto" | "dry" | "fan_only";

export interface SwitchTrait {
  state: SwitchState;
  power_w?: number;
  energy_kwh?: number;
}

export interface DimmerTrait {
  state: SwitchState;
  brightness?: number; // 0-100
}

export interface ClimateTrait {
  mode: ClimateMode;
  target_temperature_c?: number;
  current_temperature_c?: number;
  fan_mode?: FanMode;
  humidity_percent?: number;
}

export interface CoverTrait {
  position_percent?: number; // 0 closed, 100 open
  state?: "opening" | "closing" | "stopped";
}

export interface Telemetry {
  last_seen?: string; // ISO timestamp
  battery_percent?: number;
  linkquality?: number;
  signal_dbm?: number;
}

export interface DeviceTraits {
  switch?: SwitchTrait;
  dimmer?: DimmerTrait;
  climate?: ClimateTrait;
  cover?: CoverTrait;
  telemetry?: Telemetry;
}

export type ParameterType = "boolean" | "number" | "string" | "enum";

export interface CapabilityParameter {
  name: string;
  type: ParameterType;
  minimum?: number;
  maximum?: number;
  enum?: string[];
  required?: boolean;
  description?: string;
}

export interface Capability {
  action: string; // e.g. turn_on, set_brightness
  description?: string;
  parameters?: CapabilityParameter[];
}

export interface Semantics {
  tags?: string[];
  preferred_scenes?: string[];
  description?: string;
  vendor?: string;
  model?: string;
}

export interface DeviceModel {
  id: string;
  name: string;
  placement: Placement;
  protocol: Protocol;
  bindings: DeviceBindings;
  traits: DeviceTraits;
  capabilities: Capability[];
  semantics?: Semantics;
}
