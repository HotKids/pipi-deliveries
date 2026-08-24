import {
  Button,
  HStack,
  Image,
  Link,
  List,
  Navigation,
  NavigationStack,
  Section,
  SecureField,
  Spacer,
  Text,
  VStack,
  useState,
} from "scripting";
import type { AppState } from "../models";
import { sendAccountCode } from "../services/account-sync";
import {
  gatewayCredentialStatus,
  removeGatewayToken,
  saveGatewayToken,
} from "../services/credentials";
import type { GatewayCredentialStatus } from "../services/credentials";
import { loadState } from "../services/storage";
import {
  bindPhone,
  refreshAllShipments,
  unbindPhone,
} from "../services/sync";
import {
  diagnosticErrorDetails,
  diagnosticState,
  readDiagnostics,
  writeDiagnostic,
} from "../services/logger";
import { SCRIPT_BINDING_SOURCE } from "../services/script-source";
import { DiagnosticLogPage } from "./DiagnosticLogPage";
import { PhoneManagerPage } from "./PhoneManagerPage";
import { PrivacyPage } from "./PrivacyPage";
import { NotificationSettingsPage } from "./NotificationSettingsPage";
import { notificationEnabledCount } from "../services/notification-preferences";
import { transientToast } from "../services/ui-feedback";

const SCRIPT_VERSION = "0.5";
const PROJECT_URL = "https://github.com/HotKids/pipi-deliveries";

type AuthorizationState = "unauthorized" | "authorized" | "unavailable";

function authorizationState(
  credentialStatus: GatewayCredentialStatus,
): AuthorizationState {
  if (credentialStatus === "configured") return "authorized";
  if (
    credentialStatus === "unavailable" ||
    credentialStatus === "conflict"
  ) {
    return "unavailable";
  }
  return "unauthorized";
}

function authorizationPrompt(state: AuthorizationState): string {
  if (state === "authorized") return "Access Key 已保存";
  if (state === "unavailable") return "Access Key 已失效";
  return "请输入 Access Key";
}

function authorizationLabel(state: AuthorizationState): string {
  if (state === "authorized") return "已授权";
  if (state === "unavailable") return "不可用";
  return "未授权";
}

function SettingsRowIcon(props: { systemName: string }) {
  return (
    <Image
      systemName={props.systemName}
      font={17}
      symbolRenderingMode="monochrome"
      foregroundStyle="accentColor"
      frame={{ width: 22, height: 22 }}
    />
  );
}

function SettingsAccessoryIcon(props: { systemName: string }) {
  return (
    <Image
      systemName={props.systemName}
      font={13}
      symbolRenderingMode="monochrome"
      foregroundStyle="tertiaryLabel"
      frame={{ width: 14, height: 22 }}
    />
  );
}

function SettingsAppIcon() {
  return <SettingsRowIcon systemName="cat" />;
}

export function SettingsPage(props: {
  state: AppState;
  onStateChange: (state: AppState) => void;
}) {
  const dismiss = Navigation.useDismiss();
  const [token, setToken] = useState("");
  const [authorization, setAuthorization] =
    useState<AuthorizationState>("unauthorized");
  const [notice, setNotice] = useState("");
  const [authorizationNotice, setAuthorizationNotice] = useState("");
  const [destination, setDestination] =
    useState<"" | "phones" | "notifications" | "diagnostics" | "privacy">("");
  const [managerNotice, setManagerNotice] = useState("");
  const [diagnosticCount, setDiagnosticCount] = useState(
    () => readDiagnostics().length,
  );
  const [enabledNotificationCount, setEnabledNotificationCount] = useState(
    () => notificationEnabledCount(true),
  );

  const configured = authorization === "authorized";

  function refreshAuthorization(): AuthorizationState {
    try {
      const credentialStatus = gatewayCredentialStatus();
      const next = authorizationState(credentialStatus);
      setAuthorization(next);
      setAuthorizationNotice(
        credentialStatus === "conflict"
          ? "检测到本地授权记录不一致，请重新保存 Access Key"
          : "",
      );
      return next;
    } catch {
      setAuthorization("unavailable");
      setAuthorizationNotice("暂时无法读取访问授权，请稍后重试");
      return "unavailable";
    }
  }

  function saveToken() {
    try {
      saveGatewayToken(token);
      setToken("");
      refreshAuthorization();
      setNotice("Access Key 已保存");
    } catch (error) {
      refreshAuthorization();
      const value = error instanceof Error
        ? error.message
        : "Access Key 保存失败，请重试";
      if (value === "Access Key 格式不正确") {
        setAuthorizationNotice(value);
      } else {
        setNotice(value);
      }
    }
  }

  async function removeToken() {
    const confirmed = await Dialog.confirm({
      title: "移除 Access Key",
      message:
        "移除 Access Key 后将无法同步或查询快递。重新保存 Access Key 即可恢复。",
      cancelLabel: "取消",
      confirmLabel: "移除",
    });
    if (!confirmed) return;
    try {
      removeGatewayToken();
      setToken("");
      const nextAuthorization = refreshAuthorization();
      setNotice(
        nextAuthorization === "unauthorized"
          ? "Access Key 已移除"
          : "Access Key 未能移除，请重试",
      );
    } catch {
      refreshAuthorization();
      setNotice("Access Key 移除失败，请稍后重试");
    }
  }

  async function manageConfiguredToken() {
    const index = await Dialog.actionSheet({
      title: "授权管理",
      message: "Access Key 已保存。粘贴新的 Access Key 可更新授权。",
      actions: [{ label: "移除 Access Key", destructive: true }],
    });
    if (index === 0) await removeToken();
  }

  function openPhoneManager() {
    setManagerNotice("");
    setDestination("phones");
  }

  async function bindCurrentPhone(
    phone: string,
    code: string,
    flowId: string,
  ) {
    const requestedSource = SCRIPT_BINDING_SOURCE;
    const handlerSource = SCRIPT_BINDING_SOURCE;
    writeDiagnostic("binding.handler.entered", {
      flowId,
      requestedSource,
      handlerSource,
      ...diagnosticState(props.state),
      stage: "ui_handler",
    });
    const next = await bindPhone(requestedSource, phone, code, flowId);
    props.onStateChange(next);
    setManagerNotice("手机号绑定成功，关联快递将自动同步");
    void refreshAllShipments(requestedSource)
      .then((summary) => {
        props.onStateChange(summary.state);
        writeDiagnostic("binding.refresh.succeeded", {
          flowId,
          requestedSource,
          handlerSource,
          ...diagnosticState(summary.state),
          attempted: summary.attempted,
          succeeded: summary.succeeded,
          failed: summary.failed,
        });
      })
      .catch((error) => {
        writeDiagnostic(
          "binding.refresh.failed",
          {
            flowId,
            requestedSource,
            handlerSource,
            ...diagnosticState(loadState()),
            ...diagnosticErrorDetails(error),
          },
          "warning",
        );
      });
  }

  const boundPhoneCount = props.state.bindings.filter(
    (binding) => binding.source === SCRIPT_BINDING_SOURCE,
  ).length;

  return (
    <NavigationStack>
      <List
        navigationTitle="设置"
        navigationBarTitleDisplayMode="large"
        toast={transientToast(notice, setNotice)}
        toolbar={{
          topBarLeading: (
            <Button buttonStyle="plain" action={() => dismiss()}>
              <Image
                systemName="chevron.left"
                font={17}
                frame={{ width: 44, height: 44 }}
              />
            </Button>
          ),
        }}
        onAppear={() => {
          refreshAuthorization();
          setDiagnosticCount(readDiagnostics().length);
          setEnabledNotificationCount(notificationEnabledCount(true));
        }}
        navigationDestination={{
          isPresented: Boolean(destination),
          onChanged: (presented) => {
            if (presented) return;
            setDestination("");
            setDiagnosticCount(readDiagnostics().length);
            setEnabledNotificationCount(notificationEnabledCount(true));
          },
          content: destination === "phones" ? (
            <PhoneManagerPage
              bindings={props.state.bindings}
              stateRevision={props.state.revision}
              busy={false}
              notice={managerNotice}
              onSendCode={(phone) =>
                sendAccountCode(SCRIPT_BINDING_SOURCE, phone)
              }
              onBind={bindCurrentPhone}
              onRemove={(binding) => {
                setManagerNotice("");
                props.onStateChange(unbindPhone(binding.source, binding.phone));
              }}
              onRefresh={async () => {
                setManagerNotice("");
                const summary = await refreshAllShipments(undefined, {
                  forceManualRefresh: true,
                });
                props.onStateChange(summary.state);
              }}
            />
          ) : destination === "privacy" ? (
            <PrivacyPage />
          ) : destination === "notifications" ? (
            <NotificationSettingsPage
              onChanged={setEnabledNotificationCount}
            />
          ) : destination === "diagnostics" ? (
            <DiagnosticLogPage />
          ) : (
            <Text>设置</Text>
          ),
        }}
      >
        <Section header={<Text>同步</Text>}>
          <Button buttonStyle="plain" action={openPhoneManager}>
            <HStack
              spacing={12}
              padding={{ vertical: 5 }}
              frame={{ minHeight: 44, maxWidth: "infinity" }}
              contentShape="rect"
            >
              <SettingsRowIcon systemName="phone" />
              <Text>管理账号</Text>
              <Spacer />
              <Text foregroundStyle="secondaryLabel" monospacedDigit>
                {boundPhoneCount ? `已绑定 ${boundPhoneCount}` : "未绑定"}
              </Text>
              <SettingsAccessoryIcon systemName="chevron.right" />
            </HStack>
          </Button>
        </Section>

        <Section header={<Text>通知</Text>}>
          <Button
            buttonStyle="plain"
            action={() => setDestination("notifications")}
          >
            <HStack
              spacing={12}
              padding={{ vertical: 5 }}
              frame={{ minHeight: 44, maxWidth: "infinity" }}
              contentShape="rect"
            >
              <SettingsRowIcon systemName="bell" />
              <Text>通知管理</Text>
              <Spacer />
              <Text foregroundStyle="secondaryLabel" monospacedDigit>
                {enabledNotificationCount
                  ? `已开启 ${enabledNotificationCount}`
                  : "已关闭"}
              </Text>
              <SettingsAccessoryIcon systemName="chevron.right" />
            </HStack>
          </Button>
        </Section>

        <Section
          header={<Text>授权</Text>}
          footer={
            <VStack alignment="leading" spacing={4}>
              {authorizationNotice ? (
                <Text font={12} foregroundStyle="systemRed">
                  {authorizationNotice}
                </Text>
              ) : null}
              <Text font={12} foregroundStyle="secondaryLabel">
                Access Key 用于验证服务访问资格，仅保存在本机。
              </Text>
            </VStack>
          }
        >
          <HStack spacing={12} frame={{ minHeight: 44 }}>
            <SettingsRowIcon systemName="key" />
            <SecureField
              title="Access Key"
              value={token}
              onChanged={(value) => {
                setToken(value);
                setNotice("");
                setAuthorizationNotice("");
              }}
              prompt={authorizationPrompt(authorization)}
              frame={{ maxWidth: "infinity" }}
            />
            {token.trim() ? (
              <Button
                title={configured ? "更新" : "保存"}
                action={saveToken}
                buttonStyle="plain"
              />
            ) : configured ? (
              <Button
                action={manageConfiguredToken}
                buttonStyle="plain"
              >
                <Text foregroundStyle="secondaryLabel" monospacedDigit>
                  {authorizationLabel(authorization)}
                </Text>
              </Button>
            ) : (
              <Text foregroundStyle="secondaryLabel" monospacedDigit>
                {authorizationLabel(authorization)}
              </Text>
            )}
          </HStack>
        </Section>

        <Section header={<Text>支持</Text>}>
          <Button
            buttonStyle="plain"
            action={() => setDestination("diagnostics")}
          >
            <HStack
              spacing={12}
              padding={{ vertical: 5 }}
              frame={{ minHeight: 44, maxWidth: "infinity" }}
              contentShape="rect"
            >
              <SettingsRowIcon systemName="doc.text.magnifyingglass" />
              <Text>诊断日志</Text>
              <Spacer />
              {diagnosticCount ? (
                <Text foregroundStyle="secondaryLabel" monospacedDigit>
                  {diagnosticCount}
                </Text>
              ) : null}
              <SettingsAccessoryIcon systemName="chevron.right" />
            </HStack>
          </Button>
          <Button
            buttonStyle="plain"
            action={() => setDestination("privacy")}
          >
            <HStack
              spacing={12}
              padding={{ vertical: 5 }}
              frame={{ minHeight: 44, maxWidth: "infinity" }}
              contentShape="rect"
            >
              <SettingsRowIcon systemName="hand.raised" />
              <Text>隐私政策</Text>
              <Spacer />
              <SettingsAccessoryIcon systemName="chevron.right" />
            </HStack>
          </Button>
        </Section>

        <Section header={<Text>关于</Text>}>
          <HStack
            spacing={12}
            padding={{ vertical: 5 }}
            frame={{ minHeight: 44, maxWidth: "infinity" }}
          >
            <SettingsAppIcon />
            <Text>派派助手</Text>
            <Spacer />
            <Text foregroundStyle="secondaryLabel">{SCRIPT_VERSION}</Text>
          </HStack>
          <Link url={PROJECT_URL}>
            <HStack
              spacing={12}
              padding={{ vertical: 5 }}
              frame={{ minHeight: 44, maxWidth: "infinity" }}
              contentShape="rect"
            >
              <SettingsRowIcon systemName="link" />
              <Text foregroundStyle="label">项目地址</Text>
              <Spacer />
              <Text foregroundStyle="secondaryLabel">GitHub</Text>
              <SettingsAccessoryIcon systemName="arrow.up.right" />
            </HStack>
          </Link>
        </Section>
      </List>
    </NavigationStack>
  );
}
