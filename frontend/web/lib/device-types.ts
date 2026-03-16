export type CapabilityParam = {
  name: string;
  type: "boolean" | "number" | "string" | "enum";
  minimum?: number;
  maximum?: number;
  enum?: string[];
  required?: boolean;
  description?: string;
};

export type Capability = {
  action: string;
  description?: string;
  parameters?: CapabilityParam[];
};

export type DevicePlacement = {
  room?: string;
  zone?: string;
  floor?: string;
  mount?: string;
  description?: string;
  coordinates?: { x?: number; y?: number; z?: number; lat?: number; lon?: number };
};

export type DeviceBindings = {
  zigbee2mqtt?: {
    topic?: string;
    friendly_name?: string;
    ieee_address?: string;
  };
  ha_entity_id?: string;
  ha?: { entity_id?: string };
  vendor_extra?: Record<string, unknown>;
};

export type Device = {
  id: string;
  name: string;
  protocol?: string;
  placement?: DevicePlacement;
  bindings?: DeviceBindings;
  traits?: Record<string, any>;
  capabilities?: Capability[];
  semantics?: Record<string, any>;
};

export function getHaEntityId(device?: Pick<Device, "bindings"> | null) {
  const value = device?.bindings?.ha?.entity_id || device?.bindings?.ha_entity_id;
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

export function getZigbeeTopic(device?: Pick<Device, "bindings"> | null) {
  const value = device?.bindings?.zigbee2mqtt?.topic;
  return typeof value === "string" && value.trim() ? value.trim() : "";
}
