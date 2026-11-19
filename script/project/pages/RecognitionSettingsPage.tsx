import { AbortController, Button, HStack, Image, LabeledContent, List, Picker, Script, Section,
  SecureField, Spacer, Text, TextField, VStack, useColorScheme, useEffect, useRef, useState, type VirtualNode } from "scripting";
import { CONNECTION_TEST_BUDGET_MS, requestOnlineRecognition } from "../services/recognition/client";
import { prepareRecognitionConfig, providerDefaults, recognitionSettings,
  RecognitionSettingError, saveRecognitionSettings, type Format, type Mode, type Protocol, type Provider,
  type RecognitionDraft } from "../services/recognition/settings";
import { SAVE_FAILED_TOAST, transientToast } from "../services/ui-feedback";

const PROVIDERS = ["gemini", "openai", "compatible"] as const;
const PROVIDER_NAMES: Record<Provider, string> = {
  gemini: "Gemini", openai: "OpenAI", compatible: "OpenAI-Compat",
};
const CONNECTION_TESTING = "正在测试连接";
const CONNECTION_TEST_FAILED = "连接测试失败，请检查在线识别配置";

function ProviderLogo({ provider }: { provider: Provider }) {
  const dark = useColorScheme() === "dark";
  const image = provider === "gemini" ? "gemini.png" : dark ? "openai_white.png" : "openai_black.png";
  return (
    <Image filePath={`${Script.directory}/assets/recognition/${image}`} renderingMode="original"
      resizable scaleToFit frame={{ width: 20, height: 20 }} accessibilityHidden />
  );
}

function validationMessage(error: RecognitionSettingError): string {
  switch (error.field) {
    case "baseUrl": return "请输入有效的 HTTPS Base URL";
    case "apiKey": return "请输入 API Key";
    case "model": return "请输入模型名称";
    case "providerName": return "请输入有效的 Provider Name（最多 256 个字符）";
    default: return "请检查在线识别配置";
  }
}

export function RecognitionSettingsPage() {
  const [saved, setSaved] = useState(recognitionSettings);
  const [draft, setDraft] = useState(() => saved.draft);
  const [key, setKey] = useState("");
  const [reuse, setReuse] = useState(true);
  const [testing, setTesting] = useState(false);
  const [notice, setNotice] = useState("");
  const [showProviders, setShowProviders] = useState(false);
  const [validation, setValidation] = useState<RecognitionSettingError | undefined>(undefined);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => {
    request.current?.abort();
    request.current = null;
  }, []);

  const providerTitle = (draft.provider === "compatible" ? draft.providerName.trim() : "") ||
    PROVIDER_NAMES[draft.provider];
  const canReuseKey = Boolean(reuse && saved.keyLength && draft.provider === saved.draft.provider &&
    (draft.provider !== "compatible" || draft.baseUrl.trim() === saved.draft.baseUrl));
  const hasInputs = draft.model.trim() && (canReuseKey || key.trim()) &&
    (draft.provider !== "compatible" || draft.baseUrl.trim());

  function cancelTest() {
    request.current?.abort();
    request.current = null;
    setTesting(false);
    setNotice(current => current === CONNECTION_TESTING ? "" : current);
  }

  function edit(patch: Partial<RecognitionDraft>) {
    cancelTest();
    setValidation(undefined);
    if (patch.provider && patch.provider !== draft.provider ||
      patch.baseUrl !== undefined && patch.baseUrl !== draft.baseUrl) {
      setKey("");
      setReuse(false);
    }
    setDraft(previous => ({ ...previous, ...patch }));
  }

  async function testConnection() {
    cancelTest();
    setValidation(undefined);
    const controller = new AbortController();
    request.current = controller;
    try {
      const config = prepareRecognitionConfig(draft, key);
      setTesting(true);
      setNotice(CONNECTION_TESTING);
      const image = UIImage.fromFile(`${Script.directory}/assets/recognition/test-pickup-code.png`);
      if (!image) throw new Error("Connection test image unavailable");
      const result = await requestOnlineRecognition(config, image, Date.now() + CONNECTION_TEST_BUDGET_MS, controller.signal);
      if (request.current === controller) {
        setNotice(result?.family === "pickup" && result.fields.pickupCode === "0123"
          ? "连接测试成功" : CONNECTION_TEST_FAILED);
      }
    } catch (error) {
      if (request.current === controller) {
        if (error instanceof RecognitionSettingError) setValidation(error);
        else setNotice(CONNECTION_TEST_FAILED);
      }
    } finally {
      if (request.current === controller) {
        request.current = null;
        setTesting(false);
      }
    }
  }

  function save() {
    cancelTest();
    setValidation(undefined);
    try {
      saveRecognitionSettings(draft, key);
      const current = recognitionSettings();
      setSaved(current);
      setDraft(current.draft);
      setKey("");
      setReuse(true);
      setNotice("识别设置已保存");
    } catch (error) {
      if (error instanceof RecognitionSettingError && error.field !== "storage") setValidation(error);
      else setNotice(SAVE_FAILED_TOAST);
    }
  }

  function field(name: RecognitionSettingError["field"], label: string, input: VirtualNode) {
    return <VStack key={name} alignment="leading" spacing={6}>
      <LabeledContent title={label}>{input}</LabeledContent>
      {validation?.field === name ? <Text foregroundStyle="systemRed">{validationMessage(validation)}</Text> : null}
    </VStack>;
  }

  return (
    <List navigationTitle="智能识别" navigationBarTitleDisplayMode="inline" toast={transientToast(notice, setNotice)}
      toolbar={{
        topBarTrailing: (
          <Button title="保存" systemImage="checkmark" labelStyle="iconOnly"
            action={save} disabled={draft.mode === "online" && !hasInputs} />
        ),
      }}>
      <Section footer={draft.mode === "online" ? <Text>将截图发送至所选模型识别。在线识别不可用或无有效结果时，自动使用本地识别。</Text> : undefined}>
        <Picker title="识别模式" value={draft.mode} onChanged={(value: string) => edit({ mode: value as Mode })} pickerStyle="menu">
          <Text tag="online">在线识别</Text>
          <Text tag="local">本地识别</Text>
        </Picker>
        {saved.valid ? null : <Text foregroundStyle="systemRed">无法读取在线识别配置，请重新配置</Text>}
      </Section>
      {draft.mode === "online" ? (
        <Section footer={<Text>连接测试使用内置测试图片，不会保存当前设置或生成卡片。</Text>}>
          <HStack spacing={8}>
            <Text accessibilityHidden fixedSize={{ horizontal: true, vertical: false }}>Provider</Text>
            <Spacer minLength={8} />
            <Button buttonStyle="plain" layoutPriority={1} accessibilityLabel="Provider" accessibilityValue={providerTitle}
              action={() => setShowProviders(true)}
              popover={{
                isPresented: showProviders, onChanged: setShowProviders,
                arrowEdge: "top", presentationCompactAdaptation: "popover",
                content: (
                  <VStack alignment="leading" spacing={0} padding={6} fixedSize={{ horizontal: true, vertical: false }}>
                    {PROVIDERS.map(provider => (
                      <Button key={provider} buttonStyle="plain" contentShape="rect" action={() => {
                        setShowProviders(false);
                        if (provider !== draft.provider) edit(providerDefaults(provider));
                      }}>
                        <HStack spacing={8} padding={{ horizontal: 10 }}
                          frame={{ minHeight: 44, maxWidth: "infinity", alignment: "leading" }}>
                          <Image systemName="checkmark" font={12} frame={{ width: 12 }} accessibilityHidden
                            opacity={provider === draft.provider ? 1 : 0} />
                          <Text>{PROVIDER_NAMES[provider]}</Text>
                          <Spacer minLength={4} />
                          <ProviderLogo provider={provider} />
                        </HStack>
                      </Button>
                    ))}
                  </VStack>
                ),
              }}>
              <HStack spacing={8} contentShape="rect">
                <Text foregroundStyle="accentColor" lineLimit={1}>{providerTitle}</Text>
                <ProviderLogo provider={draft.provider} />
                <Image systemName="chevron.up.chevron.down" font={11} foregroundStyle="accentColor" accessibilityHidden />
              </HStack>
            </Button>
          </HStack>
          {draft.provider === "compatible" ? [
            field("providerName", "Provider Name", <TextField title="Provider Name" prompt="Provider Name" value={draft.providerName}
              onChanged={providerName => edit({ providerName })} />),
            field("baseUrl", "Base URL", <TextField title="Base URL" prompt="https://example.com/v1" value={draft.baseUrl}
              keyboardType="URL" autocorrectionDisabled textInputAutocapitalization="never" onChanged={baseUrl => edit({ baseUrl })} />),
            <Picker key="protocol" title="API Protocol" value={draft.protocol} pickerStyle="menu"
              onChanged={(value: string) => edit({ protocol: value as Protocol })}>
              <Text tag="responses">Responses</Text>
              <Text tag="chat_completions">Chat Completions</Text>
            </Picker>,
            <Picker key="format" title="Output Format" value={draft.outputFormat} pickerStyle="menu"
              onChanged={(value: string) => edit({ outputFormat: value as Format })}>
              <Text tag="json_schema">JSON Schema</Text>
              <Text tag="json">JSON</Text>
            </Picker>,
          ] : null}
          {field("apiKey", "API Key", <SecureField title="API Key" prompt={canReuseKey ? "•".repeat(Math.min(saved.keyLength, 20)) : "请输入 API Key"}
            value={key} autocorrectionDisabled textInputAutocapitalization="never" onChanged={value => {
              cancelTest();
              setValidation(undefined);
              setKey(value);
            }} />)}
          {field("model", "Model", <TextField title="Model" prompt="请输入支持图像识别的 Model ID" value={draft.model}
            autocorrectionDisabled textInputAutocapitalization="never" onChanged={model => edit({ model })} />)}
          {validation?.field === "storage" ? <Text foregroundStyle="systemRed">{validationMessage(validation)}</Text> : null}
          <Button title={testing ? "重新测试连接" : "测试连接"} buttonStyle="borderless"
            disabled={!hasInputs} action={() => void testConnection()} />
        </Section>
      ) : null}
    </List>
  );
}
