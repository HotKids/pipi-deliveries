const SETTINGS_KEY = "pipi_deliveries_online_recognition_v1";
export const OPENAI_URL = "https://api.openai.com/v1";
export const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta";

export type Mode = "local" | "online";
export type Provider = "openai" | "gemini" | "compatible";
export type Protocol = "responses" | "chat_completions" | "gemini";
export type Format = "json_schema" | "json";
export type RecognitionDraft = {
  mode: Mode;
  provider: Provider;
  providerName: string;
  baseUrl: string;
  model: string;
  protocol: Protocol;
  outputFormat: Format;
};
export type RecognitionConfig = RecognitionDraft & { apiKey: string };
type Stored = { schema: 1; revision: string; draft: RecognitionDraft; apiKey: string };

export function providerDefaults(provider: Provider) {
  const protocol: Protocol = provider === "gemini" ? "gemini" : provider === "compatible" ? "chat_completions" : "responses";
  return { provider, providerName: "", protocol, outputFormat: "json_schema" as const,
    baseUrl: provider === "openai" ? OPENAI_URL : provider === "gemini" ? GEMINI_URL : "", model: "" };
}
const defaults: RecognitionDraft = { ...providerDefaults("openai"), mode: "local" };

export class RecognitionSettingError extends Error {
  constructor(readonly field: "baseUrl" | "model" | "apiKey" | "providerName" | "storage") {
    super("Invalid recognition settings");
  }
}

export function normalizedRecognitionURL(provider: Provider, address: string): string {
  if (provider === "openai") return OPENAI_URL;
  if (provider === "gemini") return GEMINI_URL;
  if (provider !== "compatible") throw new RecognitionSettingError("storage");
  try {
    const source = address.trim();
    if (source.length > 8192 || /[?#\\\s]/u.test(source)) throw new Error();
    const url = new URL(source);
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password) throw new Error();
    return url.origin + url.pathname.replace(/\/+$/u, "");
  } catch { throw new RecognitionSettingError("baseUrl"); }
}

function validate(draft: RecognitionDraft, key: string): RecognitionConfig {
  const providerName = draft.provider === "compatible" ? draft.providerName.trim() : "";
  const model = draft.model.trim();
  const apiKey = key.trim();
  const controls = /[\u0000-\u001f\u007f-\u009f]/u;
  if (providerName.length > 256 || controls.test(providerName)) throw new RecognitionSettingError("providerName");
  const baseUrl = normalizedRecognitionURL(draft.provider, draft.baseUrl);
  if (!apiKey || apiKey.length > 8192 || controls.test(apiKey)) throw new RecognitionSettingError("apiKey");
  if (!model || model.length > 256 || controls.test(model) ||
      (draft.provider === "gemini" && !/^(?:models\/)?[A-Za-z0-9._-]+$/u.test(model))) {
    throw new RecognitionSettingError("model");
  }
  const protocol = draft.provider === "compatible" ? draft.protocol : providerDefaults(draft.provider).protocol;
  if ((draft.provider === "compatible" && protocol !== "responses" && protocol !== "chat_completions") ||
      (draft.outputFormat !== "json_schema" && draft.outputFormat !== "json")) throw new RecognitionSettingError("storage");
  return { ...draft, baseUrl, providerName, model, apiKey, protocol };
}

function read(): Stored | undefined {
  const value = Keychain.get(SETTINGS_KEY);
  if (value == null || value === "") return undefined;
  const state = JSON.parse(value) as Stored;
  if (!state || state.schema !== 1 || !state.revision || typeof state.apiKey !== "string" ||
      !["local", "online"].includes(state.draft?.mode) ||
      !["compatible", "openai", "gemini"].includes(state.draft?.provider) ||
      ![state.draft.providerName, state.draft.baseUrl, state.draft.model,
        state.draft.protocol, state.draft.outputFormat].every(field => typeof field === "string")) {
    throw new RecognitionSettingError("storage");
  }
  return state;
}

export function recognitionSettings() {
  try {
    const state = read();
    return { draft: state?.draft ?? defaults, keyLength: state?.apiKey.length ?? 0, valid: true };
  } catch { return { draft: defaults, keyLength: 0, valid: false }; }
}

export function prepareRecognitionConfig(draft: RecognitionDraft, enteredKey: string): RecognitionConfig {
  let previous: Stored | undefined;
  try { previous = read(); } catch { /* A new complete configuration can replace a damaged entry. */ }
  const url = normalizedRecognitionURL(draft.provider, draft.baseUrl);
  const sameDestination = previous?.draft.provider === draft.provider && previous.draft.baseUrl === url;
  return validate({ ...draft, baseUrl: url, mode: "online" }, enteredKey.trim() || (sameDestination ? previous!.apiKey : ""));
}

export function saveRecognitionSettings(draft: RecognitionDraft, enteredKey: string): void {
  let configuration: RecognitionConfig;
  if (draft.mode === "online") configuration = prepareRecognitionConfig(draft, enteredKey);
  else {
    const previous = read();
    configuration = { ...(previous?.draft ?? defaults), mode: "local", apiKey: previous?.apiKey ?? "" };
  }
  const { apiKey, ...savedDraft } = configuration;
  const encoded = JSON.stringify({ schema: 1, revision: UUID.string(), draft: savedDraft, apiKey });
  if (!Keychain.set(SETTINGS_KEY, encoded)) throw new RecognitionSettingError("storage");
}

export function recognitionOperation() {
  try {
    const state = read();
    const revision = state?.revision;
    const mode = state?.draft.mode ?? "local";
    const config = mode === "online" && state ? validate(state.draft, state.apiKey) : undefined;
    return { mode, config, isCurrent: () => {
      try { return read()?.revision === revision; } catch { return false; }
    } };
  } catch {
    // Preserve fallback for an unreadable saved provider configuration.
    return { mode: "online" as const, config: undefined, isCurrent: () => true };
  }
}
