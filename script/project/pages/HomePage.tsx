import {
  Button,
  HStack,
  Image,
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
import type { AppState, Shipment } from "../models";
import { ShipmentRow } from "../components/ShipmentRow";
import { EmptyDeliveryStateGroup } from "../components/EmptyDeliveryVehicle";
import {
  commitManualShipmentPreview,
  queryManualShipmentPreview,
  refreshAllShipments,
} from "../services/sync";
import type { ManualShipmentPreview } from "../services/sync";
import { visibleShipments } from "../services/storage";
import { DetailPage } from "./DetailPage";
import { selectedShipment } from "../services/ui-state";
import {
  performShipmentCompletion,
  performShipmentDeletion,
} from "../services/shipment-actions";
import { transientToast } from "../services/ui-feedback";
import {
  detectManualCarrier,
  type ManualCarrierDetection,
} from "../services/manual-query";
import { normalizeWaybill } from "../services/status";

function message(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "查询失败，请稍后重试";
}

export function HomePage(props: {
  state: AppState;
  autoFocusSearch: boolean;
  initialShipmentId: string;
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
  const [pendingSwipeAction, setPendingSwipeAction] = useState<{
    kind: "delete" | "complete";
    id: string;
  } | null>(null);
  const [manualPreview, setManualPreview] =
    useState<ManualShipmentPreview | null>(null);
  const waybillRef = useRef("");
  const phoneTailRef = useRef("");
  const queryingRef = useRef(false);
  const carrierDetectionSequenceRef = useRef(0);
  const carrierDetectionTimerRef = useRef<number | null>(null);
  const [selectedId, setSelectedId] = useState(() =>
    props.state.shipments.some(
      (shipment) => shipment.identity.id === props.initialShipmentId,
    ) ? props.initialShipmentId : "",
  );
  const shipments = visibleShipments(props.state);
  const selected = selectedShipment(
    props.state,
    selectedId,
    manualPreview?.shipment || null,
  );
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
      void detectManualCarrier(normalized)
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

  async function query() {
    if (queryingRef.current) return;
    const submittedWaybill = waybillRef.current;
    const submittedPhoneTail = phoneTailRef.current;
    if (normalizeWaybill(submittedWaybill).length < 6) {
      setValidationNotice("请输入有效的快递单号");
      return;
    }
    if (needsPhoneTail && submittedPhoneTail.length !== 4) {
      setValidationNotice("请输入 4 位手机尾号");
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
      const preview = await queryManualShipmentPreview({
        waybill: submittedWaybill,
        phoneTail: submittedPhoneTail,
      });
      setManualPreview(preview);
      setSelectedId(preview.shipment.identity.id);
      waybillRef.current = "";
      phoneTailRef.current = "";
      setWaybill("");
      setPhoneTail("");
      setNeedsPhoneTail(false);
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
      props.onStateChange(summary.state);
      if (summary.failed > 0 && summary.succeeded === 0) {
        setNotice("刷新失败，请稍后重试");
      }
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
    if (selectedId === id) setSelectedId("");
  }

  function openShipment(shipment: Shipment) {
    setSelectedId(shipment.identity.id);
  }

  function forceComplete(id: string) {
    setNotice("");
    const result = performShipmentCompletion(id);
    if (!result.ok) {
      setNotice(result.message);
      return;
    }
    props.onStateChange(result.state);
    if (selectedId === id) setSelectedId("");
  }

  function confirmPendingSwipeAction() {
    const action = pendingSwipeAction;
    setPendingSwipeAction(null);
    if (!action) return;
    if (action.kind === "delete") {
      remove(action.id);
    } else {
      forceComplete(action.id);
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
          frame={{ minHeight: 48, maxWidth: "infinity" }}
          background="tertiarySystemFill"
          clipShape={{ type: "rect", cornerRadius: 24, style: "continuous" }}
        >
          <Image systemName="number" foregroundStyle="secondaryLabel" />
          <TextField
            title="手机尾号"
            value={phoneTail}
            onChanged={(value) => {
              const next = value.replace(/\D/g, "").slice(0, 4);
              phoneTailRef.current = next;
              setPhoneTail(next);
              setValidationNotice("");
            }}
            prompt="请输入 4 位手机尾号"
            keyboardType="numberPad"
            submitLabel="search"
            onSubmit={{
              triggers: "text",
              action: () => {
                void query();
              },
            }}
          />
          <Spacer />
          <Text font={12} foregroundStyle="tertiaryLabel" monospacedDigit>
            {phoneTail.length}/4
          </Text>
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
      {validationNotice ? (
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
        confirmationDialog={{
          title: pendingSwipeAction?.kind === "delete"
            ? "删除快递"
            : "标记为已签收",
          isPresented: pendingSwipeAction != null,
          onChanged: (presented) => {
            if (!presented) setPendingSwipeAction(null);
          },
          message: (
            <Text>
              {pendingSwipeAction?.kind === "delete"
                ? "删除后，该快递及其本地物流轨迹将一并移除。"
                : "确认将该快递标记为已签收？"}
            </Text>
          ),
          actions: (
            <Button
              title={pendingSwipeAction?.kind === "delete" ? "删除" : "签收"}
              role={pendingSwipeAction?.kind === "delete" ? "destructive" : "confirm"}
              action={confirmPendingSwipeAction}
            />
          ),
        }}
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
        navigationDestination={{
          isPresented: Boolean(selected),
          onChanged: (presented) => {
            if (presented) return;
            if (manualPreview) {
              props.onStateChange(commitManualShipmentPreview(manualPreview));
              setManualPreview(null);
            }
            setSelectedId("");
          },
          content: selected ? (
            <DetailPage
              key={selected.identity.id}
              shipment={selected}
              refreshOnAppear={!manualPreview}
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
              footer={validationNotice ? (
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
                onDelete={() => setPendingSwipeAction({
                  kind: "delete",
                  id: shipment.identity.id,
                })}
                onForceComplete={() => setPendingSwipeAction({
                  kind: "complete",
                  id: shipment.identity.id,
                })}
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
                    vehicleSize={102}
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
