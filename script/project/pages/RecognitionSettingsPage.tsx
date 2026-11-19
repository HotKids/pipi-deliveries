import { AbortController, Button, HStack, Image, List, Picker, ProgressView, Script, Section,
  SecureField, Text, TextField, useColorScheme, useEffect, useRef, useState } from "scripting";
import { CONNECTION_TEST_BUDGET_MS, requestOnlineRecognition } from "../services/recognition/client";
import { normalizedRecognitionURL, prepareRecognitionConfig, providerDefaults, recognitionSettings,
  RecognitionSettingError, saveRecognitionSettings, type Format, type Mode, type Protocol, type Provider,
  type RecognitionDraft } from "../services/recognition/settings";
import { transientToast } from "../services/ui-feedback";

const PROVIDERS: Provider[] = ["gemini", "openai", "compatible"];

function ProviderOption({ provider, name }: { provider: Provider; name: string }) {
  const dark = useColorScheme() === "dark";
  const image = provider === "gemini" ? "gemini.png" : dark ? "openai_white.png" : "openai_black.png";
  return <HStack spacing={8}>
    <Image filePath={`${Script.directory}/assets/recognition/${image}`} renderingMode="original"
      resizable scaleToFit frame={{ width: 20, height: 20 }} />
    <Text lineLimit={1}>{provider === "gemini" ? "Gemini" : provider === "openai" ? "OpenAI" : name || "OpenAI-compatible"}</Text>
  </HStack>;
}

function validationMessage(error: unknown): string {
  if (!(error instanceof RecognitionSettingError)) return "无法保存识别设置，请重试";
  switch (error.field) {
    case "baseUrl": return "请输入有效的 HTTPS Base URL";
    case "apiKey": return "请输入有效的 API Key";
    case "model": return "请输入有效的模型名称";
    case "providerName": return "请输入有效的 Provider Name";
    default: return "无法保存识别设置，请重试";
  }
}

export function RecognitionSettingsPage() {
  const [saved, setSaved] = useState(recognitionSettings);
  const [draft, setDraft] = useState(() => saved.draft);
  const [key, setKey] = useState("");
  const [reuse, setReuse] = useState(true);
  const [test, setTest] = useState<"checking" | "passed" | "failed" | "">("");
  const [notice, setNotice] = useState("");
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);

  const canReuseKey = Boolean(reuse && saved.keyLength && draft.provider === saved.draft.provider &&
    (draft.provider !== "compatible" || draft.baseUrl.trim() === saved.draft.baseUrl));
  const hasInputs = draft.model.trim() && (canReuseKey || key.trim()) &&
    (draft.provider !== "compatible" || draft.baseUrl.trim());

  function cancelTest() {
    request.current?.abort();
    request.current = null;
    setTest("");
  }

  function edit(patch: Partial<RecognitionDraft>) {
    cancelTest();
    if (patch.provider && patch.provider !== draft.provider ||
      patch.baseUrl !== undefined && patch.baseUrl !== draft.baseUrl) {
      setKey("");
      setReuse(false);
    }
    setDraft(previous => ({ ...previous, ...patch }));
  }

  async function testConnection() {
    cancelTest();
    const controller = new AbortController();
    request.current = controller;
    setTest("checking");
    try {
      const config = prepareRecognitionConfig(draft, key);
      const image = UIImage.fromFile(`${Script.directory}/assets/recognition/test-pickup-code.png`);
      if (!image) throw new Error("Connection test image unavailable");
      const result = await requestOnlineRecognition(config, image, Date.now() + CONNECTION_TEST_BUDGET_MS, controller.signal);
      if (request.current === controller) setTest(result?.family === "pickup" && result.fields.pickupCode === "0123" ? "passed" : "failed");
    } catch {
      if (request.current === controller) setTest("failed");
    } finally {
      if (request.current === controller) request.current = null;
    }
  }

  function save() {
    cancelTest();
    try {
      if (draft.mode === "online") normalizedRecognitionURL(draft.provider, draft.baseUrl);
      saveRecognitionSettings(draft, key);
      const current = recognitionSettings();
      setSaved(current);
      setDraft(current.draft);
      setKey("");
      setReuse(true);
      setNotice("识别设置已保存");
    } catch (error) { setNotice(validationMessage(error)); }
  }

  return (
    <List navigationTitle="智能识别" navigationBarTitleDisplayMode="inline" toast={transientToast(notice, setNotice)}>
      <Section footer={draft.mode === "online" ? <Text>将截图发送至所选模型识别。在线识别不可用或无有效结果时，自动使用本地识别。</Text> : undefined}>
        <Picker title="识别模式" value={draft.mode} onChanged={(value: string) => edit({ mode: value as Mode })} pickerStyle="menu">
          <Text tag="online">在线识别</Text>
          <Text tag="local">本地识别</Text>
        </Picker>
        {saved.valid ? null : <Text foregroundStyle="systemRed">无法读取在线识别配置，请重新配置</Text>}
      </Section>
      {draft.mode === "online" ? (
        <Section footer={<Text>连接测试使用内置测试图片，测试结果仅显示在此页。</Text>}>
          <Picker title="Provider" value={draft.provider} pickerStyle="menu" onChanged={(value: string) => {
            const provider = value as Provider;
            if (provider === draft.provider) return;
            setKey("");
            edit(providerDefaults(provider));
          }}>
            {PROVIDERS.map(provider => <HStack key={provider} tag={provider}>
              <ProviderOption provider={provider} name={draft.providerName.trim()} />
            </HStack>)}
          </Picker>
          {draft.provider === "compatible" ? [
            <TextField key="name" title="Provider Name" prompt="Optional" value={draft.providerName}
              onChanged={providerName => edit({ providerName })} />,
            <TextField key="url" title="Base URL" prompt="请输入 HTTPS Base URL" value={draft.baseUrl}
              keyboardType="URL" autocorrectionDisabled textInputAutocapitalization="never" onChanged={baseUrl => edit({ baseUrl })} />,
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
          <SecureField title="API Key" prompt={canReuseKey ? "•".repeat(Math.min(saved.keyLength, 20)) : "请输入 API Key"}
            value={key} autocorrectionDisabled textInputAutocapitalization="never" onChanged={value => { cancelTest(); setKey(value); }} />
          <TextField title="Model" prompt="请输入支持图像识别的 Model ID" value={draft.model}
            autocorrectionDisabled textInputAutocapitalization="never" onChanged={model => edit({ model })} />
          <Button title={test === "checking" ? "重新测试连接" : "测试连接"} disabled={!hasInputs}
            action={() => void testConnection()} />
          {test === "checking" ? <ProgressView title="正在测试连接" /> : test ? (
            <Text foregroundStyle={test === "failed" ? "systemRed" : "secondaryLabel"}>
              {test === "passed" ? "连接测试成功" : "连接测试失败，请检查网络连接及在线识别配置"}
            </Text>
          ) : null}
        </Section>
      ) : null}
      <Section>
        <Button title="保存" disabled={draft.mode === "online" && !hasInputs} action={save} />
      </Section>
    </List>
  );
}
