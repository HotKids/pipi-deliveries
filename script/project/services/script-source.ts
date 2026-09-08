import type { BindingSource } from "../models";

export const SCRIPT_BINDING_SOURCE = "interface5";

export function requireScriptSource(
  source: BindingSource,
): typeof SCRIPT_BINDING_SOURCE {
  if (source !== SCRIPT_BINDING_SOURCE) {
    throw new Error("当前快递服务不可用");
  }
  return SCRIPT_BINDING_SOURCE;
}
