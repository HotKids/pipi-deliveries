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
  useEffect,
  useRef,
  useState,
} from "scripting";
import { SETTINGS_ORANGE, SettingsRowIcon } from "../components/SettingsRowIcon";
import type { AppState } from "../models";
import { sendAccountCode } from "../services/account-sync";
import { SCRIPT_VERSION } from "../services/build-track";
import {
  gatewayCredentialStatus,
  removeGatewayToken,
  saveGatewayToken,
} from "../services/credentials";
import type { GatewayCredentialStatus } from "../services/credentials";
import {
  ACCESS_KEY_ACTIVATED_ELSEWHERE_MESSAGE,
  ACCESS_KEY_INVALID_MESSAGE,
} from "../services/gateway";
import { savedKeyActivatedElsewhere } from "../services/scripting-activation";
import { loadState } from "../services/storage";
import { enhancementOperation, requireEnhancementBinding } from "../services/enhanced-account";
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
import { ParcelActivityPage, ParcelShortcutPage } from "./PickupSettingsPages";
import type { ParcelActivityContent } from "../services/parcel-pickup";
import { notificationEnabledCount } from "../services/notification-preferences";
import { reconcileFengchaoReminders } from "../services/fengchao-reminders";
import { transientToast } from "../services/ui-feedback";
import { platformRefreshMessage, refreshPlatformParcels } from "../services/platform-parcel-sync";
import { accountStatus, onPlatformAccountsChanged, PLATFORM_SOURCES } from "../services/platform-accounts";

const PROJECT_URL = "https://github.com/HotKids/pipi-deliveries";
const SETTINGS_BLUE = "#2F7BF6";
const SETTINGS_GRAY = "#8E8E93";

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
  return <SettingsRowIcon systemName="cat" backgroundColor="#B872AB" />;
}

export function SettingsPage(props: {
  state: AppState;
  pickupCards: readonly ParcelActivityContent[];
  onStateChange: (state: AppState) => void;
}) {
  const dismiss = Navigation.useDismiss();
  const [token, setToken] = useState("");
  const [authorization, setAuthorization] =
    useState<AuthorizationState>("unauthorized");
  const [notice, setNotice] = useState("");
  const [authorizationNotice, setAuthorizationNotice] = useState("");
  const [destination, setDestination] =
    useState<"" | "phones" | "notifications" | "diagnostics" | "privacy" | "shortcuts" | "activity">("");
  const [managerNotice, setManagerNotice] = useState("");
  const [platformCount, setPlatformCount] = useState(0);
  const [diagnosticCount, setDiagnosticCount] = useState(0);
  const diagnosticCountTimer = useRef<number | undefined>(undefined);

  function cancelDiagnosticCount() {
    if (diagnosticCountTimer.current !== undefined) clearTimeout(diagnosticCountTimer.current);
    diagnosticCountTimer.current = undefined;
  }

  function scheduleDiagnosticCount() {
    if (diagnosticCountTimer.current !== undefined) return;
    diagnosticCountTimer.current = setTimeout(() => {
      diagnosticCountTimer.current = undefined;
      setDiagnosticCount(readDiagnostics().length);
    }, 0);
  }

  useEffect(() => cancelDiagnosticCount, []);
  useEffect(() => {
    const refreshPlatformCount = () => {
      setPlatformCount(PLATFORM_SOURCES.filter((platform) => {
        try {
          return accountStatus(platform).state === "active";
        } catch {
          writeDiagnostic("settings.platform_count.unavailable", { sourceProvider: platform }, "warning");
          return false;
        }
      }).length);
    };
    refreshPlatformCount();
    return onPlatformAccountsChanged(refreshPlatformCount);
  }, []);
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
          // User decision 2026-09-27: the only activation prompt on this page; the Worker's
          // 403 key_activated_elsewhere for the saved key sets it, no save-time check.
          : next === "authorized" && savedKeyActivatedElsewhere()
            ? ACCESS_KEY_ACTIVATED_ELSEWHERE_MESSAGE
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
        : "保存失败，请稍后重试";
      if (value === ACCESS_KEY_INVALID_MESSAGE) {
        setAuthorizationNotice(value);
      } else {
        setNotice("保存失败，请稍后重试");
      }
    }
  }

  async function removeToken() {
    try {
      const confirmed = await Dialog.confirm({
        title: "移除 Access Key",
        message:
          "移除 Access Key 后将无法同步或查询快递。重新保存 Access Key 即可恢复。",
        cancelLabel: "取消",
        confirmLabel: "移除",
      });
      if (!confirmed) return;
      removeGatewayToken();
      setToken("");
      const nextAuthorization = refreshAuthorization();
      setNotice(
        nextAuthorization === "unauthorized"
          ? "Access Key 已移除"
          : "Access Key 移除失败，请稍后重试",
      );
    } catch {
      refreshAuthorization();
      setNotice("Access Key 移除失败，请稍后重试");
    }
  }

  async function manageConfiguredToken() {
    try {
      const index = await Dialog.actionSheet({
        title: "授权管理",
        message: "Access Key 已保存。粘贴新的 Access Key 可更新授权。",
        actions: [{ label: "移除 Access Key", destructive: true }],
      });
      if (index === 0) await removeToken();
    } catch {
      setNotice("操作失败，请稍后重试");
    }
  }

  function openPhoneManager() {
    setManagerNotice("");
    setDestination("phones");
  }

  async function bindCurrentPhone(
    phone: string,
    code: string,
    flowId: string,
    enhanced = false,
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
    const next = await bindPhone(requestedSource, phone, code, flowId, enhanced);
    props.onStateChange(next);
    void refreshAllShipments(requestedSource, { accountListOnly: true })
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
  const boundAccountCount = boundPhoneCount + platformCount;

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
          scheduleDiagnosticCount();
          setEnabledNotificationCount(notificationEnabledCount(true));
        }}
        onDisappear={cancelDiagnosticCount}
        navigationDestination={{
          isPresented: Boolean(destination),
          onChanged: (presented) => {
            if (presented) return;
            setDestination("");
            scheduleDiagnosticCount();
            setEnabledNotificationCount(notificationEnabledCount(true));
          },
          content: destination === "phones" ? (
            <PhoneManagerPage
              bindings={props.state.bindings}
              stateRevision={props.state.revision}
              busy={false}
              notice={managerNotice}
              pendingEnhancementUnsubscribeCount={props.state.pendingEnhancementUnsubscribes?.length || 0}
              unresolvedEnhancementUnsubscribeCount={props.state.pendingEnhancementUnsubscribes?.filter(
                item => !item.identityFingerprint).length || 0}
              onSendCode={(phone, _flowId, enhanced) => {
                if (enhanced) {
                  requireEnhancementBinding(loadState().bindings, phone);
                  return enhancementOperation("code", phone);
                }
                return sendAccountCode(SCRIPT_BINDING_SOURCE, phone);
              }}
              onBind={bindCurrentPhone}
              onPlatformRefresh={async (platform, onProgress) => platformRefreshMessage(
                await refreshPlatformParcels(props.onStateChange, "manual", platform, onProgress),
              )}
              onRemove={async (binding, localOnly) => {
                setManagerNotice("");
                props.onStateChange(await unbindPhone(binding.source, binding.phone, { localOnly, expectedBinding: binding }));
              }}
              onRefresh={async () => {
                setManagerNotice("");
                const summary = await refreshAllShipments(undefined, {
                  forceManualRefresh: true,
                });
                props.onStateChange(summary.state);
                // The manager reports the outcome through refreshSummaryToast, exactly as
                // HomePage does, so the counts must reach it instead of being dropped here.
                return summary;
              }}
            />
          ) : destination === "privacy" ? (
            <PrivacyPage />
          ) : destination === "notifications" ? (
            <NotificationSettingsPage
              onChanged={(count) => {
                setEnabledNotificationCount(count);
                void reconcileFengchaoReminders(props.state);
              }}
            />
          ) : destination === "shortcuts" ? (
            <ParcelShortcutPage />
          ) : destination === "activity" ? (
            <ParcelActivityPage cards={props.pickupCards} revision={props.state.revision} />
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
              <SettingsRowIcon systemName="phone" backgroundColor={SETTINGS_ORANGE} />
              <Text>管理账号</Text>
              <Spacer />
              <Text foregroundStyle="secondaryLabel" monospacedDigit>
                {boundAccountCount ? `已绑定 ${boundAccountCount}` : "未绑定"}
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
              <SettingsRowIcon systemName="bell" backgroundColor={SETTINGS_BLUE} />
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

        <Section header={<Text>更多</Text>}>
          <Button buttonStyle="plain" action={() => setDestination("shortcuts")}>
            <HStack
              spacing={12}
              padding={{ vertical: 5 }}
              frame={{ minHeight: 44, maxWidth: "infinity" }}
              contentShape="rect"
            >
              <SettingsRowIcon systemName="square.on.square" backgroundColor={SETTINGS_ORANGE} />
              <Text>快捷指令</Text>
              <Spacer />
              <SettingsAccessoryIcon systemName="chevron.right" />
            </HStack>
          </Button>
          <Button buttonStyle="plain" action={() => setDestination("activity")}>
            <HStack
              spacing={12}
              padding={{ vertical: 5 }}
              frame={{ minHeight: 44, maxWidth: "infinity" }}
              contentShape="rect"
            >
              <SettingsRowIcon systemName="rectangle.inset.filled.badge.record" backgroundColor={SETTINGS_BLUE} />
              <Text>实时活动</Text>
              <Spacer />
              <SettingsAccessoryIcon systemName="chevron.right" />
            </HStack>
          </Button>
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
              <SettingsRowIcon systemName="doc.text.magnifyingglass" backgroundColor={SETTINGS_GRAY} />
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
              <SettingsRowIcon systemName="hand.raised" backgroundColor="#34A853" />
              <Text>隐私政策</Text>
              <Spacer />
              <SettingsAccessoryIcon systemName="chevron.right" />
            </HStack>
          </Button>
        </Section>

        <Section
          header={<Text>授权</Text>}
          footer={
            <VStack alignment="leading" spacing={4}>
              {authorizationNotice ? (
                <Text font="footnote" lineSpacing={3} foregroundStyle="systemRed">
                  {authorizationNotice}
                </Text>
              ) : null}
              <Text font="footnote" lineSpacing={3} foregroundStyle="secondaryLabel">
                Access Key 用于激活脚本使用权限，并授权同步快递信息。请妥善保管，勿与他人分享。
              </Text>
            </VStack>
          }
        >
          <HStack spacing={12} frame={{ minHeight: 44 }}>
            <SettingsRowIcon systemName="key" backgroundColor={SETTINGS_ORANGE} />
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
              <SettingsRowIcon systemName="link" backgroundColor={SETTINGS_GRAY} />
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
