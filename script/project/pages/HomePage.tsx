import {
  Button,
  HStack,
  Image,
  List,
  Navigation,
  NavigationStack,
  ProgressView,
  Section,
  Spacer,
  Text,
  TextField,
  VStack,
  useEffect,
  useRef,
  useState,
} from "scripting";
import type { AppState, RefreshSummary, Shipment } from "../models";
import { ShipmentRow } from "../components/ShipmentRow";
import { EmptyDeliveryStateGroup } from "../components/EmptyDeliveryVehicle";
import {
  commitManualShipmentPreview,
  queryManualShipmentPreview,
  refreshAllShipments,
} from "../services/sync";
import { stateLoadFailure, visibleShipments } from "../services/storage";
import { DetailPage } from "./DetailPage";
import {
  consumeShipmentNavigationTarget,
  manualPreviewNavigationTarget,
  persistedShipmentNavigationTarget,
  promotedPendingShipmentNavigationTarget,
  selectedNavigationShipment,
  shipmentNavigationTargetId,
  type ShipmentNavigationTarget,
} from "../services/ui-state";
import {
  performShipmentCompletion,
  performShipmentDeletion,
} from "../services/shipment-actions";
import {
  errorMessage,
  isManualQueryValidationMessage,
  manualQueryFailureToast,
  refreshSummaryToast,
  transientToast,
} from "../services/ui-feedback";
import {
  ManualCarrierDetectionCoordinator,
  type ManualCarrierDetection,
} from "../services/manual-query";
import { manualPreviewNeedsDetailRefresh } from "../services/manual-preview";
import { normalizeWaybill } from "../services/status";
import {
  displayWaybill,
  isJingDongSourceShipment,
  jingDongAutomaticH5TimelineAvailable,
  needsAutomaticManualFallback,
  selectShipmentTimeline,
  unprojectedAccountOrder,
} from "../services/shipment-policy";
import { EXPRESS_TOAST_COPY } from "../services/express-toast-copy";

export function HomePage(props: {
  state: AppState;
  autoFocusSearch: boolean;
  initialShipmentId: string;
  navigationRequestGeneration: number;
  onStateChange: (state: AppState) => void;
}) {
  const dismiss = Navigation.useDismiss();
  const [waybill, setWaybill] = useState("");
  const [phoneTail, setPhoneTail] = useState("");
  const [needsPhoneTail, setNeedsPhoneTail] = useState(false);
  const [detectedCarrier, setDetectedCarrier] = useState<
    ManualCarrierDetection | null
  >(null);
  const [querying, setQuerying] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const deletingRef = useRef(false);
  const [completing, setCompleting] = useState(false);
  const completingRef = useRef(false);
  const [notice, setNotice] = useState("");
  const [validationNotice, setValidationNotice] = useState("");
  const waybillRef = useRef("");
  const phoneTailRef = useRef("");
  const queryingRef = useRef(false);
  const carrierDetectionSequenceRef = useRef(0);
  const carrierDetectionTimerRef = useRef<number | null>(null);
  const carrierDetectionCoordinatorRef = useRef<
    ManualCarrierDetectionCoordinator | null
  >(null);
  if (!carrierDetectionCoordinatorRef.current) {
    carrierDetectionCoordinatorRef.current = new ManualCarrierDetectionCoordinator();
  }
  const initialNavigationTarget = props.state.shipments.some(
    (shipment) => shipment.identity.id === props.initialShipmentId,
  )
    ? persistedShipmentNavigationTarget(props.initialShipmentId)
    : null;
  const [shipmentNavigationTarget, setShipmentNavigationTargetState] = useState<
    ShipmentNavigationTarget | null
  >(() => initialNavigationTarget);
  const shipmentNavigationTargetRef = useRef<ShipmentNavigationTarget | null>(
    initialNavigationTarget,
  );
  const shipments = visibleShipments(props.state);
  const selected = selectedNavigationShipment(
    props.state,
    shipmentNavigationTarget,
  );
  const manualPreview = shipmentNavigationTarget?.kind === "manualPreview"
    ? shipmentNavigationTarget.preview
    : null;
  const phoneTailValidation = validationNotice.includes("手机尾号");

  function setShipmentNavigationTarget(
    target: ShipmentNavigationTarget | null,
  ) {
    shipmentNavigationTargetRef.current = target;
    setShipmentNavigationTargetState(target);
  }

  function applyInteractiveRefreshSummary(summary: RefreshSummary) {
    const promotedTarget = promotedPendingShipmentNavigationTarget(
      summary,
      shipmentNavigationTargetRef.current,
    );
    props.onStateChange(summary.state);
    if (promotedTarget) setShipmentNavigationTarget(promotedTarget);
  }

  useEffect(() => {
    let active = true;
    // 所有副本都迁移失败时不是空库，而是读取失败（2026-09-06 静态审查②）：进页先说一声。
    if (stateLoadFailure()) setNotice(EXPRESS_TOAST_COPY.stateLoadFailed);
    void refreshAllShipments()
      .then((summary) => {
        if (active) props.onStateChange(summary.state);
      })
      .catch(() => {
        /* cached data remains available when the launch refresh fails */
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!props.initialShipmentId) return;
    if (!props.state.shipments.some(
      (shipment) => shipment.identity.id === props.initialShipmentId,
    )) return;
    setShipmentNavigationTarget(
      persistedShipmentNavigationTarget(props.initialShipmentId),
    );
  }, [props.navigationRequestGeneration]);

  useEffect(() => {
    return () => {
      carrierDetectionSequenceRef.current += 1;
      if (carrierDetectionTimerRef.current != null) {
        clearTimeout(carrierDetectionTimerRef.current);
      }
    };
  }, []);

  function scheduleCarrierDetection(value: string) {
    const normalized = normalizeWaybill(value);
    const sequence = carrierDetectionSequenceRef.current + 1;
    carrierDetectionSequenceRef.current = sequence;
    if (carrierDetectionTimerRef.current != null) {
      clearTimeout(carrierDetectionTimerRef.current);
      carrierDetectionTimerRef.current = null;
    }
    setDetectedCarrier(null);
    if (normalized.length < 6) return;

    carrierDetectionTimerRef.current = setTimeout(() => {
      carrierDetectionTimerRef.current = null;
      void carrierDetectionCoordinatorRef.current!.resolve(normalized)
        .then((carrier) => {
          if (
            sequence === carrierDetectionSequenceRef.current &&
            normalizeWaybill(waybillRef.current) === normalized
          ) {
            setDetectedCarrier(carrier);
          }
        })
        .catch(() => {
          if (sequence === carrierDetectionSequenceRef.current) {
            setDetectedCarrier(null);
          }
        });
    }, 250);
  }

  function clearQueryInputs() {
    carrierDetectionSequenceRef.current += 1;
    if (carrierDetectionTimerRef.current != null) {
      clearTimeout(carrierDetectionTimerRef.current);
      carrierDetectionTimerRef.current = null;
    }
    waybillRef.current = "";
    phoneTailRef.current = "";
    setWaybill("");
    setPhoneTail("");
    setNeedsPhoneTail(false);
    setDetectedCarrier(null);
    Keyboard.hide();
  }

  async function query() {
    if (queryingRef.current) return;
    const submittedWaybill = waybillRef.current;
    const submittedPhoneTail = phoneTailRef.current;
    const submittedNormalized = normalizeWaybill(submittedWaybill);
    if (submittedNormalized.length < 6) {
      setValidationNotice("请输入有效的快递单号");
      return;
    }
    // Checked before carrier detection and before any provider round: a waybill the list already
    // tracks must not spend a recognition call, a provider query or a second row.
    const alreadyListed = props.state.shipments.find(
      (shipment) => normalizeWaybill(displayWaybill(shipment)) === submittedNormalized,
    );
    if (alreadyListed) {
      setValidationNotice("");
      setNotice(EXPRESS_TOAST_COPY.alreadyInList);
      // 用户定 2026-09-05：提示「已在列表」的同时打开那一票的详情（三端同）。
      openShipment(alreadyListed);
      return;
    }
    // 尾号输入框已经在页面上（承运商要尾号）却还没填满四位时，先内联提示，不要先弹「正在查询」——
    // 用户 2026-09-08 报：顺丰的单号识别出来了、尾号还空着，点查询弹的是「正在查询，请稍候」。
    if ((needsPhoneTail || detectedCarrier?.requiresPhoneTail)
      && submittedPhoneTail.length !== 4) {
      setNeedsPhoneTail(true);
      // 一个字都没填就是「请输入手机尾号」（与 Lite 的尾号对话框标题同字，用户定 2026-09-08）；
      // 填了但不满四位才提示位数。
      setValidationNotice(
        submittedPhoneTail ? "请输入 4 位手机尾号" : "请输入手机尾号",
      );
      return;
    }
    queryingRef.current = true;
    setQuerying(true);
    carrierDetectionSequenceRef.current += 1;
    if (carrierDetectionTimerRef.current != null) {
      clearTimeout(carrierDetectionTimerRef.current);
      carrierDetectionTimerRef.current = null;
    }
    setDetectedCarrier(null);
    // 统一 toast（AGENTS §11）：提交即短弹一次「正在查询」，不再常驻到查完。
    setNotice(EXPRESS_TOAST_COPY.manualQuerying);
    setValidationNotice("");
    try {
      let submittedCarrier: ManualCarrierDetection | null = null;
      try {
        submittedCarrier = await carrierDetectionCoordinatorRef.current!.resolve(
          submittedWaybill,
        );
      } catch {
        submittedCarrier = null;
      }
      if (submittedCarrier) setDetectedCarrier(submittedCarrier);
      if (
        (submittedCarrier?.requiresPhoneTail || needsPhoneTail) &&
        submittedPhoneTail.length !== 4
      ) {
        setNeedsPhoneTail(true);
        setValidationNotice(
          submittedPhoneTail ? "请输入 4 位手机尾号" : "请输入手机尾号",
        );
        return;
      }
      const preview = await queryManualShipmentPreview({
        waybill: submittedWaybill,
        phoneTail: submittedPhoneTail,
        presentation: submittedCarrier,
      });
      const committed = commitManualShipmentPreview(preview);
      props.onStateChange(committed);
      setShipmentNavigationTarget(
        manualPreviewNavigationTarget(preview, committed),
      );
      clearQueryInputs();
    } catch (error) {
      // 校验类文案内联显示；其余一律走统一的失败 / 超时 toast，上游文案不外露。
      const value = errorMessage(error, "");
      if (isManualQueryValidationMessage(value)) {
        setValidationNotice(value);
      } else {
        setNotice(manualQueryFailureToast(error));
      }
      if (value.includes("手机尾号")) setNeedsPhoneTail(true);
      scheduleCarrierDetection(submittedWaybill);
    } finally {
      queryingRef.current = false;
      setQuerying(false);
    }
  }

  async function refresh() {
    if (refreshing) return;
    setRefreshing(true);
    setNotice("");
    try {
      const summary = await refreshAllShipments(undefined, {
        forceManualRefresh: true,
      });
      applyInteractiveRefreshSummary(summary);
      setNotice(refreshSummaryToast(summary));
    } catch (error) {
      // One gesture, one outcome: refreshAllShipments resolves with failures on the line above
      // and rejects here, so both branches have to say 刷新失败 rather than 查询失败.
      setNotice(EXPRESS_TOAST_COPY.refreshFailed);
    } finally {
      setRefreshing(false);
    }
  }

  // The same shape PhoneManagerPage.remove uses, down to the in-flight guard and the catch:
  // `Dialog` is a host global (nothing in this project imports it), rows must sit inside a
  // Section for the list to keep row identity, and an unguarded throw from a swipe action ends
  // the whole script session instead of showing a toast (index.tsx:127-129).
  async function confirmDelete(shipment: Shipment): Promise<void> {
    if (deletingRef.current) return;
    deletingRef.current = true;
    setDeleting(true);
    setNotice("");
    try {
      const confirmed = await Dialog.confirm({
        title: "要删除此快递吗？",
        message: "删除后，该快递及其本地物流轨迹将一并移除。",
        cancelLabel: "取消",
        confirmLabel: "删除",
      });
      if (!confirmed) return;
      remove(shipment.identity.id);
    } catch (error) {
      // 删除这一个手势只有两种结果：该快递已删除 / 删除失败（AGENTS §11 统一表）。
      setNotice(EXPRESS_TOAST_COPY.deleteFailed);
    } finally {
      deletingRef.current = false;
      setDeleting(false);
    }
  }

  function remove(id: string) {
    setNotice("");
    const result = performShipmentDeletion(id);
    if (!result.ok) {
      setNotice(EXPRESS_TOAST_COPY.deleteFailed);
      return;
    }
    props.onStateChange(result.state);
    setNotice(EXPRESS_TOAST_COPY.deleted);
    if (shipmentNavigationTargetId(shipmentNavigationTarget) === id) {
      setShipmentNavigationTarget(null);
    }
  }

  // 与 confirmDelete 同一套：行只声明手势，确认在页面，任何抛出都收进 toast。签收之后这一票
  // 就被 forcedCompletedAtMs 闩住，后续自动同步不再改它；想放开只能删掉，下一轮同步会带回来。
  async function confirmComplete(shipment: Shipment): Promise<void> {
    if (completingRef.current) return;
    completingRef.current = true;
    setCompleting(true);
    setNotice("");
    try {
      const confirmed = await Dialog.confirm({
        title: "要标记为已签收吗？",
        message: "标记后该快递状态不再随自动同步更新，删除后下一轮同步可重新带回。",
        cancelLabel: "取消",
        confirmLabel: "签收",
      });
      if (!confirmed) return;
      complete(shipment.identity.id);
    } catch (error) {
      setNotice(EXPRESS_TOAST_COPY.signFailed);
    } finally {
      completingRef.current = false;
      setCompleting(false);
    }
  }

  function complete(id: string) {
    setNotice("");
    const result = performShipmentCompletion(id);
    if (!result.ok) {
      setNotice(EXPRESS_TOAST_COPY.signFailed);
      return;
    }
    props.onStateChange(result.state);
    setNotice(EXPRESS_TOAST_COPY.signed);
  }

  function openShipment(shipment: Shipment) {
    setShipmentNavigationTarget(
      persistedShipmentNavigationTarget(shipment.identity.id),
    );
  }


  const searchFields = (
    <VStack
      spacing={8}
      padding={{ vertical: 2 }}
      listRowSeparator="hidden"
    >
      <HStack
        spacing={10}
        padding={{ horizontal: 14 }}
        frame={{ minHeight: 52, maxWidth: "infinity" }}
        background="tertiarySystemFill"
        clipShape={{ type: "rect", cornerRadius: 26, style: "continuous" }}
      >
        <Image
          systemName="magnifyingglass"
          font={18}
          foregroundStyle="secondaryLabel"
        />
        <TextField
          title="查询快递单号"
          value={waybill}
          onChanged={(value) => {
            waybillRef.current = value;
            setWaybill(value);
            phoneTailRef.current = "";
            setPhoneTail("");
            setNeedsPhoneTail(false);
            setValidationNotice("");
            scheduleCarrierDetection(value);
          }}
          prompt="查询快递单号"
          autofocus={props.autoFocusSearch}
          textContentType="shipmentTrackingNumber"
          submitLabel="search"
          onSubmit={{
            triggers: "text",
            action: () => {
              void query();
            },
          }}
          frame={{ maxWidth: "infinity" }}
        />
        {detectedCarrier ? (
          <Button
            action={() => {
              void query();
            }}
            buttonStyle="plain"
          >
            <Text
              font={14}
              foregroundStyle="accentColor"
              lineLimit={1}
              minScaleFactor={0.75}
              frame={{ minWidth: 48, height: 44, alignment: "trailing" }}
              contentShape="rect"
            >
              {detectedCarrier.companyName}
            </Text>
          </Button>
        ) : querying ? (
          <ProgressView progressViewStyle="circular" />
        ) : null}
      </HStack>
      {needsPhoneTail ? (
        <HStack
          spacing={9}
          padding={{ horizontal: 14 }}
          frame={{ minHeight: 52, maxWidth: "infinity" }}
          background="tertiarySystemFill"
          clipShape={{ type: "rect", cornerRadius: 24, style: "continuous" }}
        >
          <Image
            systemName="phone"
            foregroundStyle={phoneTailValidation ? "systemRed" : "secondaryLabel"}
          />
          <VStack
            alignment="leading"
            spacing={1}
            frame={{ maxWidth: "infinity", alignment: "leading" }}
          >
            <TextField
              title="手机尾号"
              value={phoneTail}
              onChanged={(value) => {
                const next = value.replace(/\D/g, "").slice(0, 4);
                phoneTailRef.current = next;
                setPhoneTail(next);
                setValidationNotice("");
              }}
              prompt={phoneTailValidation
                ? validationNotice
                : "请输入 4 位手机尾号"}
              keyboardType="numberPad"
              submitLabel="search"
              onSubmit={{
                triggers: "text",
                action: () => {
                  void query();
                },
              }}
              frame={{ maxWidth: "infinity" }}
            />
            {phoneTailValidation && phoneTail ? (
              <Text font={11} foregroundStyle="systemRed" lineLimit={1}>
                {validationNotice}
              </Text>
            ) : null}
          </VStack>
          <Button
            title={querying ? "查询中…" : "查询"}
            buttonStyle="plain"
            action={() => {
              void query();
            }}
          />
        </HStack>
      ) : null}
    </VStack>
  );
  const emptySearchArea = (
    <VStack
      spacing={6}
      padding={{ horizontal: 20, vertical: 8 }}
      frame={{ maxWidth: "infinity" }}
      background="systemBackground"
    >
      {searchFields}
      {validationNotice && !phoneTailValidation ? (
        <Text
          font={12}
          foregroundStyle="systemRed"
          frame={{ maxWidth: "infinity", alignment: "leading" }}
        >
          {validationNotice}
        </Text>
      ) : null}
    </VStack>
  );

  return (
    <NavigationStack>
      <VStack
        frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
        navigationTitle="我的快递"
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
          topBarTrailing: (
            <Button
              buttonStyle="plain"
              action={() => setNotice("暂未接入")}
            >
              <Image
                systemName="plus"
                font={17}
                frame={{ width: 44, height: 44 }}
              />
            </Button>
          ),
        }}
        navigationDestination={{
          isPresented: Boolean(selected),
          onChanged: (presented) => {
            if (presented) return;
            const consumed = consumeShipmentNavigationTarget(
              shipmentNavigationTargetRef.current,
            );
            setShipmentNavigationTarget(consumed.nextTarget);
          },
          content: selected ? (
            <DetailPage
              key={selected.identity.id}
              shipment={selected}
              manualPreview={manualPreview}
              refreshOnAppear={manualPreview
                ? manualPreviewNeedsDetailRefresh(selected)
                  ? "manual_submit"
                  : false
                // Complete history can still lack structured status; detail entry may query that missing field.
                : unprojectedAccountOrder(selected)
                  ? "identity_projection"
                  : needsAutomaticManualFallback(selected) ||
                      selectShipmentTimeline(selected).semantic === "UNKNOWN"
                    ? "detail_open"
                    : false}
              onStateChange={(next) => {
                props.onStateChange(next);
              }}
            />
          ) : <Text>快递详情</Text>,
        }}
      >
        {shipments.length ? (
          <List listStyle="plain" refreshable={refresh}>
            <Section
              footer={validationNotice && !phoneTailValidation ? (
                <Text font={12} foregroundStyle="systemRed">
                  {validationNotice}
                </Text>
              ) : undefined}
            >
              {searchFields}
            </Section>
            <Section>
              {shipments.map((shipment) => (
                <ShipmentRow
                  key={shipment.identity.id}
                  shipment={shipment}
                  onOpen={() => openShipment(shipment)}
                  onDelete={() => void confirmDelete(shipment)}
                  onComplete={() => void confirmComplete(shipment)}
                  deleteDisabled={deleting}
                  completeDisabled={completing}
                />
              ))}
            </Section>
            <VStack
              spacing={8}
              padding={{ bottom: 12 }}
              frame={{ maxWidth: "infinity" }}
              listRowSeparator="hidden"
            >
              <Text
                font={12}
                foregroundStyle="tertiaryLabel"
                frame={{ maxWidth: "infinity", alignment: "center" }}
              >
                只显示 14 天内的快递信息
              </Text>
            </VStack>
          </List>
        ) : (
          <VStack
            spacing={0}
            frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
          >
            {emptySearchArea}
            <List
              listStyle="plain"
              refreshable={refresh}
              frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
              overlay={{
                alignment: "center",
                content: (
                  <EmptyDeliveryStateGroup
                    vehicleSize={81.6}
                    spacing={6}
                    labelFont={24}
                  />
                ),
              }}
            />
          </VStack>
        )}
      </VStack>
    </NavigationStack>
  );
}
