import { EXPRESS_TOAST_COPY } from "../services/express-toast-copy";
import {
  Button,
  HStack,
  Image,
  List,
  Section,
  Spacer,
  Text,
  VStack,
  useEffect,
  useRef,
  useState,
} from "scripting";
import type { AccountBinding, RefreshSummary } from "../models";
import { EXPRESS_POLICY } from "../contracts/express-policy.generated";
import { writeDiagnostic } from "../services/logger";
import { SCRIPT_BINDING_SOURCE } from "../services/script-source";
import {
  errorMessage,
  refreshSummaryToast,
  transientToast,
} from "../services/ui-feedback";
import { PhoneBindingPage } from "./PhoneBindingPage";

type MaybeAsync = void | Promise<void>;

export type PhoneManagerPageProps = {
  bindings: readonly AccountBinding[];
  stateRevision: number;
  busy: boolean;
  notice?: string;
  onSendCode: (phone: string, flowId: string) => MaybeAsync;
  onBind: (phone: string, code: string, flowId: string) => MaybeAsync;
  onRemove: (binding: AccountBinding) => MaybeAsync;
  onRefresh: () => Promise<RefreshSummary>;
};

export function PhoneManagerPage(props: PhoneManagerPageProps) {
  const [localBusy, setLocalBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [bindingPresented, setBindingPresented] = useState(false);
  const mountedRef = useRef(true);
  const actionInFlightRef = useRef(false);

  const visibleBindings = props.bindings.filter(
    (binding) => binding.source === SCRIPT_BINDING_SOURCE,
  );
  const busy = props.busy || localBusy;

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    writeDiagnostic("manager.rendered", {
      activeSource: SCRIPT_BINDING_SOURCE,
      revision: props.stateRevision,
      v5Bindings: visibleBindings.length,
    });
  }, [props.stateRevision, visibleBindings.length]);

  useEffect(() => {
    if (props.notice) setNotice(props.notice);
  }, [props.notice]);

  async function runAction(
    action: () => MaybeAsync,
    fallback: string,
    success = "",
  ) {
    if (props.busy || actionInFlightRef.current) return;
    actionInFlightRef.current = true;
    setLocalBusy(true);
    setNotice("");
    try {
      await action();
      if (mountedRef.current && success) setNotice(success);
    } catch (error) {
      if (mountedRef.current) setNotice(errorMessage(error, fallback));
    } finally {
      actionInFlightRef.current = false;
      if (mountedRef.current) setLocalBusy(false);
    }
  }

  async function refresh() {
    // Same gesture and same call as HomePage.refresh, so it reports through the same helper:
    // refreshAllShipments resolves with failed > 0 rather than rejecting, which runAction's
    // "did it throw" success argument read as 刷新完成. The action sets its own notice and
    // runAction supplies only the failure fallback — the shape remove() already uses.
    await runAction(async () => {
      // 上游文案不外露：拒绝也只报统一的「刷新失败」（AGENTS §11 统一表）。
      const summary = await props.onRefresh().catch(() => null);
      if (mountedRef.current) {
        setNotice(summary ? refreshSummaryToast(summary) : EXPRESS_TOAST_COPY.refreshFailed);
      }
    }, EXPRESS_TOAST_COPY.refreshFailed);
  }

  function add() {
    if (busy) return;
    setBindingPresented(true);
  }

  async function remove(binding: AccountBinding) {
    await runAction(async () => {
      const confirmed = await Dialog.confirm({
        title: "解绑手机号",
        message: `解绑后，与 ${binding.phone} 关联的快递也将一并删除。`,
        cancelLabel: "取消",
        confirmLabel: "解绑",
      });
      if (!confirmed) return;
      await props.onRemove(binding);
      if (mountedRef.current) setNotice(EXPRESS_TOAST_COPY.phoneUnbound);
    }, EXPRESS_TOAST_COPY.unbindFailed);
  }

  return (
    <List
      navigationTitle="管理账号"
      navigationBarTitleDisplayMode="inline"
      refreshable={refresh}
      toast={transientToast(notice, setNotice)}
      navigationDestination={{
        isPresented: bindingPresented,
        onChanged: setBindingPresented,
        content: (
          <PhoneBindingPage
            onSendCode={props.onSendCode}
            onBind={async (phone, code, flowId) => {
              await props.onBind(phone, code, flowId);
              if (mountedRef.current) {
                setBindingPresented(false);
                setNotice(EXPRESS_TOAST_COPY.phoneBound);
              }
            }}
          />
        ),
      }}
      toolbar={{
        topBarTrailing: (
          <Button
            buttonStyle="plain"
            action={add}
            disabled={
              busy ||
              visibleBindings.length >= EXPRESS_POLICY.sources.maxBindingsPerSource
            }
          >
            <Image
              systemName="plus"
              font={17}
              frame={{ width: 44, height: 44 }}
            />
          </Button>
        ),
      }}
    >
      <Section
        header={
          <Text>
            {`已绑定 ${visibleBindings.length}/${EXPRESS_POLICY.sources.maxBindingsPerSource}`}
          </Text>
        }
        footer={
          <Text font={12} foregroundStyle="secondaryLabel">
            最多可绑定 {EXPRESS_POLICY.sources.maxBindingsPerSource} 个手机号；绑定后，将自动同步关联的快递信息。
          </Text>
        }
      >
        {visibleBindings.length ? (
          visibleBindings.map((binding) => (
            <HStack
              key={`${binding.source}:${binding.phone}`}
              spacing={12}
              padding={{ vertical: 6 }}
              trailingSwipeActions={{
                allowsFullSwipe: false,
                actions: [
                  <Button
                    title="解绑"
                    role="destructive"
                    action={() => remove(binding)}
                    disabled={busy}
                  />,
                ],
              }}
            >
              <Image systemName="phone.fill" foregroundStyle="accentColor" />
              <Text font={17} monospacedDigit>
                {binding.phone}
              </Text>
              <Spacer />
              <Text font={13} foregroundStyle="secondaryLabel">
                已绑定
              </Text>
            </HStack>
          ))
        ) : (
          <VStack
            spacing={8}
            padding={{ vertical: 28 }}
            frame={{ maxWidth: "infinity" }}
          >
            <Image
              systemName="iphone"
              font={32}
              foregroundStyle="tertiaryLabel"
            />
            <Text font={15} fontWeight="medium">尚未绑定手机号</Text>
            <Text font={12} foregroundStyle="secondaryLabel">
              轻点右上角的“+”添加
            </Text>
          </VStack>
        )}
      </Section>
    </List>
  );
}
