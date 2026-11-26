import { INPUT_ROW_HEIGHT } from "../components/input-metrics";
import { EXPRESS_TOAST_COPY } from "../services/express-toast-copy";
import {
  Button,
  Divider,
  HStack,
  List,
  Section,
  Text,
  TextField,
  VStack,
  useEffect,
  useRef,
  useState,
} from "scripting";
import type { AccountBinding } from "../models";
import { EXPRESS_POLICY } from "../contracts/express-policy.generated";
import {
  beginDiagnosticFlow,
  createDiagnosticFlowId,
  diagnosticErrorDetails,
  writeDiagnostic,
} from "../services/logger";
import { SCRIPT_BINDING_SOURCE } from "../services/script-source";
import { errorMessage, transientToast } from "../services/ui-feedback";

type MaybeAsync = void | Promise<void>;

export type PhoneBindingPageProps = {
  bindings: readonly AccountBinding[];
  purpose?: "fengchao" | "samsung";
  onCancel?: () => void;
  initialPhone?: string;
  onSendCode: (
    phone: string,
    flowId: string,
    enhanced: boolean,
  ) => MaybeAsync;
  onBind: (
    phone: string,
    code: string,
    flowId: string,
    enhanced: boolean,
  ) => MaybeAsync;
};

function normalizedPhone(value: string): string {
  return value.replace(/\D/g, "").slice(0, 11);
}

function validPhone(value: string): boolean {
  return /^1[3-9]\d{9}$/.test(value);
}

export function PhoneBindingPage(props: PhoneBindingPageProps) {
  const cabinet = props.purpose === "fengchao";
  const enhanced = props.purpose === "samsung";
  const [phone, setPhone] = useState(() => normalizedPhone(props.initialPhone || ""));
  const [code, setCode] = useState("");
  const [verificationPhone, setVerificationPhone] = useState("");
  const [sending, setSending] = useState(false);
  const [binding, setBinding] = useState(false);
  const [notice, setNotice] = useState("");
  const [resendAtMs, setResendAtMs] = useState(0);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const mountedRef = useRef(true);
  const requestSequenceRef = useRef(0);
  const phoneRef = useRef(phone);
  const flowIdRef = useRef(createDiagnosticFlowId("binding"));

  const maxCodeLength = enhanced ? 8 : 6;
  const inputRowHeight = INPUT_ROW_HEIGHT;
  const remainingSeconds = Math.max(
    0,
    Math.ceil((resendAtMs - nowMs) / 1_000),
  );
  const busy = sending || binding;
  const visibleBindings = props.bindings.filter(
    (binding) => binding.source === SCRIPT_BINDING_SOURCE,
  );
  const hasBaseBinding = visibleBindings.some((binding) => binding.phone === phone);
  const bindingAllowed = cabinet || (enhanced
    ? hasBaseBinding
    : hasBaseBinding || visibleBindings.length < EXPRESS_POLICY.sources.maxBindingsPerSource);
  const verificationMatches = verificationPhone === phone && validPhone(phone);
  const codeValid = code.length >= 4;
  const canBind = bindingAllowed && verificationMatches && codeValid && !busy;
  const submitTitle = enhanced
    ? (binding ? "正在验证…" : "验证")
    : (binding ? "正在绑定…" : "绑定");

  useEffect(() => {
    // D4 (owner 2026-11-21 「开始并入终态，卡住另记（推荐）」): opening the page writes no start line; the code request
    // and the verification each end with their own line under this flow id.
    return () => {
      mountedRef.current = false;
      requestSequenceRef.current += 1;
    };
  }, []);

  useEffect(() => {
    if (resendAtMs <= 0) return;
    let timer: number | null = null;

    const tick = () => {
      const current = Date.now();
      if (!mountedRef.current) return;
      setNowMs(current);
      if (current < resendAtMs) {
        timer = setTimeout(tick, Math.min(1_000, resendAtMs - current));
      }
    };

    tick();
    return () => {
      if (timer != null) clearTimeout(timer);
    };
  }, [resendAtMs]);

  function changePhone(value: string) {
    if (enhanced) return;
    const next = normalizedPhone(value);
    phoneRef.current = next;
    setPhone(next);
    setNotice("");
    if (next !== verificationPhone) {
      requestSequenceRef.current += 1;
      setCode("");
      setVerificationPhone("");
      setResendAtMs(0);
    }
  }

  function changeCode(value: string) {
    setCode(value.replace(/\D/g, "").slice(0, maxCodeLength));
    setNotice("");
  }

  async function sendCode() {
    if (busy || remainingSeconds > 0 || !validPhone(phone) || !bindingAllowed) return;
    const requestedPhone = phone;
    const requestedEnhanced = enhanced;
    const requestedSource = SCRIPT_BINDING_SOURCE;
    const requestId = requestSequenceRef.current + 1;
    requestSequenceRef.current = requestId;
    setSending(true);
    setNotice("");
    setCode("");
    setVerificationPhone("");
    setResendAtMs(0);

    try {
      if (!cabinet) beginDiagnosticFlow("binding.code.started", {
        flowId: flowIdRef.current,
        requestedSource,
      });
      await props.onSendCode(
        requestedPhone,
        flowIdRef.current,
        requestedEnhanced,
      );
      if (
        !mountedRef.current ||
        requestId !== requestSequenceRef.current ||
        phoneRef.current !== requestedPhone
      ) {
        // R5-NEW-07 ②: the code was sent; a page closed or a phone changed meanwhile still ends the flow.
        if (!cabinet) writeDiagnostic("binding.code.succeeded", {
          flowId: flowIdRef.current,
          requestedSource,
          cancelReason: mountedRef.current ? "user" : "page_closed",
        });
        return;
      }
      const sentAt = Date.now();
      setNowMs(sentAt);
      setResendAtMs(sentAt + 60_000);
      setVerificationPhone(requestedPhone);
      setNotice(EXPRESS_TOAST_COPY.codeSent);
      if (!cabinet) writeDiagnostic("binding.code.succeeded", {
        flowId: flowIdRef.current,
        requestedSource,
      });
    } catch (error) {
      if (!cabinet) writeDiagnostic(
        "binding.code.failed",
        {
          flowId: flowIdRef.current,
          requestedSource,
          ...diagnosticErrorDetails(error),
        },
        // D202 (D3): a code request that failed is retried by the user, so it is a WARNING.
        "warning",
      );
      if (mountedRef.current && requestId === requestSequenceRef.current) {
        setNotice(errorMessage(error, EXPRESS_TOAST_COPY.codeSendFailed));
      }
    } finally {
      if (mountedRef.current && requestId === requestSequenceRef.current) {
        setSending(false);
      }
    }
  }

  async function bindPhone() {
    if (!canBind) return;
    const requestedPhone = phone;
    const requestedCode = code;
    const requestedEnhanced = enhanced;
    const requestedSource = SCRIPT_BINDING_SOURCE;
    const requestId = requestSequenceRef.current + 1;
    requestSequenceRef.current = requestId;
    setBinding(true);
    setNotice("");
    setBindError("");

    try {
      await props.onBind(
        requestedPhone,
        requestedCode,
        flowIdRef.current,
        requestedEnhanced,
      );
      if (
        !mountedRef.current ||
        requestId !== requestSequenceRef.current ||
        phoneRef.current !== requestedPhone
      ) {
        return;
      }
    } catch (error) {
      if (mountedRef.current && requestId === requestSequenceRef.current) {
        // 绑定失败留在表单内联显示（三端同：Pipi _bindError、Lite showError）。
        setBindError(errorMessage(error, EXPRESS_TOAST_COPY.bindFailed));
      }
    } finally {
      if (mountedRef.current && requestId === requestSequenceRef.current) {
        setBinding(false);
      }
    }
  }

  const [bindError, setBindError] = useState("");
  const validationNotice =
    enhanced && validPhone(phone) && !hasBaseBinding
      ? "请先在手机号同步中绑定该手机号"
      : !enhanced && !bindingAllowed
        ? `最多可绑定 ${EXPRESS_POLICY.sources.maxBindingsPerSource} 个手机号`
        : phone.length > 0 && !validPhone(phone)
          ? "请输入有效的 11 位手机号"
          : code.length > 0 && code.length < 4
            ? "请输入至少 4 位验证码"
            : code.length >= 4 && !verificationMatches
              ? "请先获取该手机号的验证码"
              : "";

  return (
    <List
      navigationTitle={enhanced ? "验证三星生活助手" : cabinet ? "登录丰巢" : "绑定手机号"}
      navigationBarTitleDisplayMode="inline"
      toolbar={props.onCancel ? { topBarLeading: <Button title="取消" action={props.onCancel} /> } : undefined}
      toast={transientToast(notice, setNotice)}
    >
      <Section
        header={<Text>验证手机号</Text>}
        footer={
          <VStack alignment="leading" spacing={4}>
            {validationNotice || bindError ? (
              <Text font="footnote" lineSpacing={3} foregroundStyle="systemRed">
                {validationNotice || bindError}
              </Text>
            ) : null}
            <Text font="footnote" lineSpacing={3} foregroundStyle="secondaryLabel">
              绑定的手机号仅用于查询和同步快递。
            </Text>
          </VStack>
        }
      >
        <VStack spacing={0} listRowSeparator="hidden">
          <TextField
            title="手机号"
            value={phone}
            onChanged={changePhone}
            prompt="请输入手机号"
            keyboardType="phonePad"
            textContentType="telephoneNumber"
            autofocus={!enhanced}
            disabled={busy || enhanced}
            frame={{ minHeight: inputRowHeight, maxHeight: inputRowHeight, maxWidth: "infinity" }}
            overlay={{
              alignment: "bottom",
              content: (
                <Divider
                  frame={{ minHeight: 1, maxHeight: 1, maxWidth: "infinity" }}
                />
              ),
            }}
          />
          <HStack
            spacing={10}
            frame={{ minHeight: inputRowHeight, maxHeight: inputRowHeight, maxWidth: "infinity" }}
          >
            <TextField
              title="验证码"
              value={code}
              onChanged={changeCode}
              prompt="请输入验证码"
              keyboardType="numberPad"
              textContentType="oneTimeCode"
              disabled={busy}
              frame={{ minHeight: inputRowHeight, maxHeight: inputRowHeight, maxWidth: "infinity" }}
            />
            <Button
              title={
                sending
                  ? "正在发送…"
                  : remainingSeconds > 0
                    ? `${remainingSeconds} 秒后重发`
                    : "获取验证码"
              }
              action={sendCode}
              disabled={busy || remainingSeconds > 0 || !validPhone(phone) || !bindingAllowed}
              buttonStyle="plain"
              monospacedDigit
              frame={{ minWidth: 112, minHeight: 44, alignment: "trailing" }}
            />
          </HStack>
          <Divider />
          <HStack
            frame={{ maxWidth: "infinity", alignment: "center" }}
            padding={{ top: 18 }}
          >
            <Button
              action={bindPhone}
              disabled={!canBind}
              buttonStyle="borderedProminent"
              buttonBorderShape="capsule"
            >
              <Text frame={{ minWidth: 220, minHeight: 44 }}>
                {submitTitle}
              </Text>
            </Button>
          </HStack>
        </VStack>
      </Section>
    </List>
  );
}
