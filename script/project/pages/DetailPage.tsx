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
import { refreshShipmentById } from "../services/sync";
import {
  displayWaybill,
  unprojectedAccountOrder,
} from "../services/shipment-policy";
import {
  isProviderErrorDetail,
  statusLabel,
  statusTint,
} from "../services/status";
import { timelineTimeParts } from "../services/time-presentation";
import { preferNewerShipment } from "../services/ui-state";
import { copyText } from "../services/clipboard";
import { transientToast } from "../services/ui-feedback";

export function DetailPage(props: {
  shipment: Shipment;
  refreshOnAppear?: boolean;
  onStateChange?: (state: AppState, shipment: Shipment) => void;
}) {
  const [shipment, setShipment] = useState(props.shipment);
  const [notice, setNotice] = useState("");
  const refreshGenerationRef = useRef(0);
  const refreshInFlightRef = useRef<Promise<void> | null>(null);
  const displayTracks = shipment.timeline.tracks.filter(
    (track) => Boolean(track.detail.trim()) && !isProviderErrorDetail(track.detail),
  );
  const hotline = courierHotline(
    shipment.identity.courierCode,
    shipment.identity.companyName,
  );
  const waybill = displayWaybill(shipment);

  useEffect(() => {
    setShipment((current) => preferNewerShipment(current, props.shipment));
  }, [props.shipment.identity.id, props.shipment.updatedAtMs]);

  useEffect(() => {
    if (props.refreshOnAppear === false) return;
    void refresh(false);
    return () => {
      refreshGenerationRef.current += 1;
      refreshInFlightRef.current = null;
    };
  }, [props.shipment.identity.id, props.refreshOnAppear]);

  function refresh(forceManualRefresh = false): Promise<void> {
    if (refreshInFlightRef.current) return refreshInFlightRef.current;
    const generation = refreshGenerationRef.current + 1;
    refreshGenerationRef.current = generation;
    const task = (async () => {
      setNotice("");
      try {
        const result = await refreshShipmentById(
          props.shipment.identity.id,
          { forceAccountOrderProjection: true, forceManualRefresh },
        );
        if (generation !== refreshGenerationRef.current) return;
        setShipment((current) => preferNewerShipment(current, result.shipment));
        props.onStateChange?.(result.state, result.shipment);
      } catch {
        if (generation === refreshGenerationRef.current) {
          setNotice("暂时无法更新，已显示本地缓存");
        }
      }
    })();
    refreshInFlightRef.current = task;
    void task.then(() => {
      if (refreshInFlightRef.current === task) {
        refreshInFlightRef.current = null;
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
            courierCode={shipment.identity.courierCode}
            companyName={shipment.identity.companyName}
            accountOrder={Boolean(unprojectedAccountOrder(shipment))}
            size={72}
            cornerRadius={17}
          />
          <VStack alignment="leading" spacing={4} frame={{ maxWidth: "infinity" }}>
            <Text
              font={17}
              fontWeight="bold"
              foregroundStyle={statusTint(shipment.timeline.semantic)}
              lineLimit={1}
            >
              {statusLabel(shipment.timeline.semantic)}
            </Text>
            <HStack
              alignment="center"
              spacing={0}
              frame={{ maxWidth: "infinity", alignment: "leading" }}
            >
              <Text font={15}>{shipment.identity.companyName}：</Text>
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

      <Section header={<Text>物流轨迹</Text>}>
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
                      ? statusTint(shipment.timeline.semantic)
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
