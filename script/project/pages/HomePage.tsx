import {
  Button,
  HStack,
  Image,
  Keyboard,
  List,
  Navigation,
  NavigationStack,
  ProgressView,
  Rectangle,
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
import { visibleShipments } from "../services/storage";
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
  manualQueryToast,
  refreshSummaryToast,
} from "../services/ui-feedback";
import {
  ManualCarrierDetectionCoordinator,
  type ManualCarrierDetection,
} from "../services/manual-query";
import { manualPreviewNeedsDetailRefresh } from "../services/manual-preview";
import { normalizeWaybill } from "../services/status";
import {
  isJingDongSourceShipment,
  jingDongAutomaticH5TimelineAvailable,
  needsAutomaticManualFallback,
  unprojectedAccountOrder,
} from "../services/shipment-policy";

function message(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "查询失败，请稍后重试";
}

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
    if (normalizeWaybill(submittedWaybill).length < 6) {
      setValidationNotice("请输入有效的快递单号");
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
    setNotice("");
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
        setValidationNotice("请输入 4 位手机尾号");
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
      const value = message(error);
      const isValidation = value.includes("快递单号")
        || value.includes("手机尾号");
      if (isValidation) {
        setValidationNotice(value);
      } else {
        setNotice(value);
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
      setNotice(message(error));
    } finally {
      setRefreshing(false);
    }
  }

  function remove(id: string) {
    setNotice("");
    const result = performShipmentDeletion(id);
    if (!result.ok) {
      setNotice(result.message);
      return;
    }
    props.onStateChange(result.state);
    setNotice("该快递已删除");
    if (shipmentNavigationTargetId(shipmentNavigationTarget) === id) {
      setShipmentNavigationTarget(null);
    }
  }

  function openShipment(shipment: Shipment) {
    setShipmentNavigationTarget(
      persistedShipmentNavigationTarget(shipment.identity.id),
    );
  }

  function forceComplete(id: string) {
    setNotice("");
    const result = performShipmentCompletion(id);
    if (!result.ok) {
      setNotice(result.message);
      return;
    }
    props.onStateChange(result.state);
    setNotice("已标记为签收");
    if (shipmentNavigationTargetId(shipmentNavigationTarget) === id) {
      setShipmentNavigationTarget(null);
    }
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
        toast={manualQueryToast(querying, notice, setNotice)}
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
              <Text
                font={17}
                frame={{ width: 44, height: 44 }}
              >
                添加
              </Text>
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
                : unprojectedAccountOrder(selected)
                  ? "identity_projection"
                  : isJingDongSourceShipment(selected) &&
                      !jingDongAutomaticH5TimelineAvailable(selected)
                    ? "detail_open"
                  : needsAutomaticManualFallback(selected)
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
            {shipments.map((shipment) => (
              <ShipmentRow
                key={shipment.identity.id}
                shipment={shipment}
                onOpen={() => openShipment(shipment)}
                onDelete={() => remove(shipment.identity.id)}
                onForceComplete={() => forceComplete(shipment.identity.id)}
              />
            ))}
            <VStack
              spacing={8}
              padding={{ bottom: 12 }}
              frame={{ maxWidth: "infinity" }}
              listRowSeparator="hidden"
            >
              <Rectangle
                fill="separator"
                frame={{ minHeight: 0.5, maxHeight: 0.5, maxWidth: "infinity" }}
                padding={{ leading: 60 }}
              />
              <Text
                font={12}
                foregroundStyle="tertiaryLabel"
                frame={{ maxWidth: "infinity", alignment: "center" }}
              >
                只显示 7 天内的快递信息
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
