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
import {
  createDiagnosticFlowId,
  diagnosticErrorDetails,
  writeDiagnostic,
} from "../services/logger";
import { SCRIPT_BINDING_SOURCE } from "../services/script-source";
import { transientToast } from "../services/ui-feedback";

type MaybeAsync = void | Promise<void>;

export type PhoneBindingPageProps = {
  onSendCode: (
    phone: string,
    flowId: string,
  ) => MaybeAsync;
  onBind: (
    phone: string,
    code: string,
    flowId: string,
  ) => MaybeAsync;
};

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function normalizedPhone(value: string): string {
  return value.replace(/\D/g, "").slice(0, 11);
}

function validPhone(value: string): boolean {
  return /^1[3-9]\d{9}$/.test(value);
}

export function PhoneBindingPage(props: PhoneBindingPageProps) {
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [verificationPhone, setVerificationPhone] = useState("");
  const [sending, setSending] = useState(false);
  const [binding, setBinding] = useState(false);
  const [notice, setNotice] = useState("");
  const [resendAtMs, setResendAtMs] = useState(0);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const mountedRef = useRef(true);
  const requestSequenceRef = useRef(0);
  const phoneRef = useRef("");
  const flowIdRef = useRef(createDiagnosticFlowId("binding"));

  const maxCodeLength = 6;
  const inputRowHeight = 50;
  const remainingSeconds = Math.max(
    0,
    Math.ceil((resendAtMs - nowMs) / 1_000),
  );
  const busy = sending || binding;
  const verificationMatches = verificationPhone === phone && validPhone(phone);
  const codeValid = code.length >= 4;
  const canBind = verificationMatches && codeValid && !busy;

  useEffect(() => {
    writeDiagnostic("binding.flow.opened", {
      flowId: flowIdRef.current,
      requestedSource: SCRIPT_BINDING_SOURCE,
    });
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
    if (busy || remainingSeconds > 0 || !validPhone(phone)) return;
    const requestedPhone = phone;
    const requestedSource = SCRIPT_BINDING_SOURCE;
    const requestId = requestSequenceRef.current + 1;
    requestSequenceRef.current = requestId;
    setSending(true);
    setNotice("");
    setCode("");
    setVerificationPhone("");
    setResendAtMs(0);

    try {
      writeDiagnostic("binding.code.started", {
        flowId: flowIdRef.current,
        requestedSource,
      });
      await props.onSendCode(
        requestedPhone,
        flowIdRef.current,
      );
      if (
        !mountedRef.current ||
        requestId !== requestSequenceRef.current ||
        phoneRef.current !== requestedPhone
      ) {
        return;
      }
      const sentAt = Date.now();
      setNowMs(sentAt);
      setResendAtMs(sentAt + 60_000);
      setVerificationPhone(requestedPhone);
      setNotice("验证码已发送，请注意查收");
      writeDiagnostic("binding.code.succeeded", {
        flowId: flowIdRef.current,
        requestedSource,
      });
    } catch (error) {
      writeDiagnostic(
        "binding.code.failed",
        {
          flowId: flowIdRef.current,
          requestedSource,
          ...diagnosticErrorDetails(error),
        },
        "error",
      );
      if (mountedRef.current && requestId === requestSequenceRef.current) {
        setNotice(errorMessage(error, "验证码发送失败，请稍后重试"));
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
    const requestedSource = SCRIPT_BINDING_SOURCE;
    const requestId = requestSequenceRef.current + 1;
    requestSequenceRef.current = requestId;
    setBinding(true);
    setNotice("");

    try {
      await props.onBind(
        requestedPhone,
        requestedCode,
        flowIdRef.current,
      );
      if (
        !mountedRef.current ||
        requestId !== requestSequenceRef.current
      ) {
        return;
      }
    } catch (error) {
      if (mountedRef.current && requestId === requestSequenceRef.current) {
        setNotice(errorMessage(error, "绑定失败，请稍后重试"));
      }
    } finally {
      if (mountedRef.current && requestId === requestSequenceRef.current) {
        setBinding(false);
      }
    }
  }

  const validationNotice =
    phone.length > 0 && !validPhone(phone)
      ? "请输入有效的 11 位手机号"
      : code.length > 0 && code.length < 4
        ? "请输入至少 4 位验证码"
        : code.length >= 4 && !verificationMatches
          ? "请先获取该手机号的验证码"
          : "";

  return (
    <List
      navigationTitle="绑定手机号"
      navigationBarTitleDisplayMode="inline"
      toast={transientToast(notice, setNotice)}
    >
      <Section
        header={<Text>验证手机号</Text>}
        footer={
          <VStack alignment="leading" spacing={5}>
            {validationNotice ? (
              <Text font={12} foregroundStyle="systemRed">
                {validationNotice}
              </Text>
            ) : null}
            <Text font={12} foregroundStyle="secondaryLabel">
              隐私声明：绑定的手机号仅用于查询快递，不作其他用途。
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
            autofocus
            disabled={busy}
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
                  ? "发送中…"
                  : remainingSeconds > 0
                    ? `${remainingSeconds} 秒后重试`
                    : "获取验证码"
              }
              action={sendCode}
              disabled={busy || remainingSeconds > 0 || !validPhone(phone)}
              buttonStyle="plain"
              frame={{ minWidth: 112, minHeight: 44, alignment: "trailing" }}
            />
          </HStack>
          <Divider />
        </VStack>
        <HStack
          frame={{ maxWidth: "infinity", alignment: "center" }}
          listRowSeparator="hidden"
        >
          <Button
            action={bindPhone}
            disabled={!canBind}
            buttonStyle="borderedProminent"
            buttonBorderShape="capsule"
          >
            <Text frame={{ minWidth: 220, minHeight: 44 }}>
              {binding ? "绑定中…" : "绑定"}
            </Text>
          </Button>
        </HStack>
      </Section>
    </List>
  );
}
