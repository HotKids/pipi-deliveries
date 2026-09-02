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
import type { AppState, Shipment } from "../models";
import { CourierIcon } from "../components/CourierIcon";
import { courierHotline } from "../services/carrier-presentation";
import {
  continueManualShipmentPreview,
  refreshShipmentById,
  type ManualShipmentPreview,
} from "../services/sync";
import {
  displayWaybill,
  selectShipmentDetailTimeline,
  unprojectedAccountOrder,
} from "../services/shipment-policy";
import {
  isProviderErrorDetail,
  shipmentDetailPresentationStatus,
  statusTint,
} from "../services/status";
import { timelineTimeParts } from "../services/time-presentation";
import { preferNewerShipment } from "../services/ui-state";
import { copyText } from "../services/clipboard";
import {
  manualDetailRefreshToast,
  transientToast,
} from "../services/ui-feedback";
import {
  diagnosticErrorDetails,
  writeDiagnostic,
} from "../services/logger";

export function DetailPage(props: {
  shipment: Shipment;
  manualPreview?: ManualShipmentPreview | null;
  refreshOnAppear?:
    | "manual_submit"
    | "identity_projection"
    | "detail_open"
    | false;
  onStateChange?: (state: AppState, shipment: Shipment) => void;
}) {
  const [shipment, setShipment] = useState(props.shipment);
  const [notice, setNotice] = useState("");
  const [loadingManualDetail, setLoadingManualDetail] = useState(
    props.refreshOnAppear === "manual_submit",
  );
  const refreshGenerationRef = useRef(0);
  const refreshInFlightRef = useRef<Promise<void> | null>(null);
  const refreshAbortRef = useRef<AbortController | null>(null);
  const detailTimeline = selectShipmentDetailTimeline(shipment);
  const usesKuaidi100Detail =
    detailTimeline.provider.trim().toLowerCase() === "kuaidi100_h5";
  const detailCourierCode = usesKuaidi100Detail
    ? detailTimeline.courierCode
    : shipment.identity.courierCode;
  const detailCompanyName = usesKuaidi100Detail
    ? detailTimeline.companyName
    : shipment.identity.companyName;
  const displayTracks = detailTimeline.tracks.filter(
    (track) => Boolean(track.detail.trim()) && !isProviderErrorDetail(track.detail),
  );
  const hotline = courierHotline(
    detailCourierCode,
    detailCompanyName,
  );
  const waybill = displayWaybill(shipment);
  const presentationStatus = shipmentDetailPresentationStatus(
    shipment,
    detailTimeline,
  );

  useEffect(() => {
    setShipment((current) => preferNewerShipment(current, props.shipment));
  }, [props.shipment.identity.id, props.shipment.updatedAtMs]);

  useEffect(() => {
    if (!props.refreshOnAppear) return;
    if (props.refreshOnAppear === "manual_submit") {
      setLoadingManualDetail(true);
    }
    void refresh(false);
    return () => {
      refreshGenerationRef.current += 1;
      refreshAbortRef.current?.abort();
      refreshAbortRef.current = null;
      refreshInFlightRef.current = null;
    };
  }, [props.shipment.identity.id, props.refreshOnAppear]);

  function refresh(forceManualRefresh = false): Promise<void> {
    if (refreshInFlightRef.current) return refreshInFlightRef.current;
    const generation = refreshGenerationRef.current + 1;
    refreshGenerationRef.current = generation;
    const controller = new AbortController();
    refreshAbortRef.current = controller;
    const task = (async () => {
      setNotice("");
      try {
        const result = props.refreshOnAppear === "manual_submit" &&
            props.manualPreview?.roundComplete === false &&
            !forceManualRefresh
          ? await continueManualShipmentPreview(props.manualPreview, {
              signal: controller.signal,
            })
          : await refreshShipmentById(props.shipment.identity.id, {
            forceAccountOrderProjection:
              forceManualRefresh || props.refreshOnAppear === "identity_projection",
            forceManualRefresh,
            includeKdniaoFallback:
              forceManualRefresh ||
              props.refreshOnAppear === "manual_submit" ||
              props.refreshOnAppear === "identity_projection" ||
              props.refreshOnAppear === "detail_open",
            trigger: forceManualRefresh
              ? "detail_pull"
              : props.refreshOnAppear || "detail_open",
            signal: controller.signal,
          });
        if (generation !== refreshGenerationRef.current) return;
        setShipment((current) => preferNewerShipment(current, result.shipment));
        props.onStateChange?.(result.state, result.shipment);
        const hasUsableDetail = selectShipmentDetailTimeline(
          result.shipment,
        ).tracks.some(
          (track) =>
            Boolean(track.detail.trim()) &&
            !isProviderErrorDetail(track.detail),
        );
        if (props.refreshOnAppear === "manual_submit") {
          setNotice(manualDetailRefreshToast(
            result.refreshed,
            hasUsableDetail,
          ));
        } else if (forceManualRefresh) {
          setNotice(
            result.refreshed && hasUsableDetail
              ? "轨迹加载成功"
              : hasUsableDetail
                ? "当前轨迹已是最新"
                : "暂未获取到可用轨迹",
          );
        }
      } catch (error) {
        if (generation === refreshGenerationRef.current) {
          const errorDetails = diagnosticErrorDetails(error);
          if (errorDetails.errorCategory === "removed") return;
          writeDiagnostic("detail.refresh.ui_failed", {
            trigger: forceManualRefresh
              ? "detail_pull"
              : props.refreshOnAppear || "detail_open",
            ...errorDetails,
          }, "warning");
          if (!displayTracks.length) {
            setNotice("轨迹更新失败，请稍后重试");
          }
        }
      } finally {
        if (
          generation === refreshGenerationRef.current &&
          !forceManualRefresh &&
          props.refreshOnAppear === "manual_submit"
        ) {
          setLoadingManualDetail(false);
        }
      }
    })();
    refreshInFlightRef.current = task;
    void task.then(() => {
      if (refreshInFlightRef.current === task) {
        refreshInFlightRef.current = null;
      }
      if (refreshAbortRef.current === controller) {
        refreshAbortRef.current = null;
      }
    });
    return task;
  }

  async function copyWaybill() {
    const result = await copyText(waybill);
    setNotice(
      result === "copied"
        ? "运单号已复制"
        : "复制失败，请稍后重试",
    );
  }

  return (
    <List
      navigationTitle="物流详情"
      navigationBarTitleDisplayMode="inline"
      refreshable={() => refresh(true)}
      toast={transientToast(notice, setNotice)}
    >
      <Section>
        <HStack spacing={14} padding={{ vertical: 12 }}>
          <CourierIcon
            courierCode={detailCourierCode}
            companyName={detailCompanyName}
            accountOrder={Boolean(
              !usesKuaidi100Detail && unprojectedAccountOrder(shipment),
            )}
            size={72}
            cornerRadius={17}
          />
          <VStack alignment="leading" spacing={4} frame={{ maxWidth: "infinity" }}>
            <Text
              font={17}
              fontWeight="bold"
              foregroundStyle={statusTint(presentationStatus.semantic)}
              lineLimit={1}
            >
              {presentationStatus.text}
            </Text>
            <HStack
              alignment="center"
              spacing={0}
              frame={{ maxWidth: "infinity", alignment: "leading" }}
            >
              <Text font={15}>{detailCompanyName}：</Text>
              <HStack alignment="center" spacing={5}>
                <Text
                  font={15}
                  monospacedDigit
                  lineLimit={1}
                  minScaleFactor={0.65}
                  allowsTightening={true}
                  layoutPriority={1}
                >
                  {waybill}
                </Text>
                <Button buttonStyle="plain" action={copyWaybill}>
                  <Image
                    systemName="doc.on.doc"
                    font={13}
                    foregroundStyle="secondaryLabel"
                  />
                </Button>
              </HStack>
            </HStack>
            {hotline ? (
              <HStack spacing={0}>
                <Text font={15}>官方电话：</Text>
                <Text
                  font={15}
                  foregroundStyle="systemBlue"
                  monospacedDigit
                  styledText={{
                    content: [{ content: hotline, link: `tel:${hotline}` }],
                  }}
                />
                <Spacer />
              </HStack>
            ) : null}
          </VStack>
          <Spacer />
        </HStack>
      </Section>

      <Section
        header={<Text>物流轨迹</Text>}
        footer={(
          <Text
            font={12}
            foregroundStyle="tertiaryLabel"
            frame={{ maxWidth: "infinity", alignment: "center" }}
          >
            {loadingManualDetail
              ? "轨迹详情正在加载中。"
              : "轨迹不完整时，可尝试下拉刷新。"}
          </Text>
        )}
      >
        {displayTracks.length ? (
          displayTracks.map((track, index) => {
            const time = timelineTimeParts(track.timeText);
            return (
              <HStack
                key={`${track.timeText}:${track.detail}:${index}`}
                alignment="top"
                spacing={11}
                padding={{ vertical: 5 }}
              >
                <VStack
                  alignment="trailing"
                  spacing={2}
                  frame={{ width: 52, alignment: "trailing" }}
                >
                  <Text font={14} fontWeight="medium" monospacedDigit lineLimit={1}>
                    {time.time || "--:--"}
                  </Text>
                  {time.date ? (
                    <Text font={11} foregroundStyle="tertiaryLabel" monospacedDigit>
                      {time.date}
                    </Text>
                  ) : null}
                </VStack>
                <Image
                  systemName={index === 0 ? "circle.fill" : "circle"}
                  font={10}
                  foregroundStyle={
                    index === 0
                      ? statusTint(presentationStatus.semantic)
                      : "tertiaryLabel"
                  }
                  frame={{ width: 12 }}
                />
                <Text
                  font={15}
                  foregroundStyle={index === 0 ? "label" : "secondaryLabel"}
                  frame={{ maxWidth: "infinity", alignment: "leading" }}
                >
                  {track.detail}
                </Text>
              </HStack>
            );
          })
        ) : (
          <VStack
            spacing={8}
            padding={{ vertical: 26 }}
            frame={{ maxWidth: "infinity" }}
          >
            <Image
              systemName="clock.arrow.circlepath"
              font={28}
              foregroundStyle="tertiaryLabel"
            />
            <Text font={14} foregroundStyle="secondaryLabel">
              暂无物流轨迹
            </Text>
          </VStack>
        )}
      </Section>
    </List>
  );
}
