import {
  AppEvents,
  Button,
  GeometryReader,
  List,
  Navigation,
  NavigationStack,
  Notification,
  Script,
  Section,
  Tab,
  TabView,
  Text,
  WebView,
  ZStack,
  useEffect,
  useMemo,
  useObservable,
  useRef,
  useState,
} from "scripting";
import {
  createProjectionViewportHost,
  registerProjectionViewportHost,
  setProjectionSceneActive,
  type ProjectionViewportView,
} from "./services/projection-viewport";
import type { AppState } from "./models";
import { HomePage } from "./pages/HomePage";
import { SettingsPage, useSettingsOverview } from "./pages/SettingsPage";
import { preparePickupBoxAnimation } from "./components/PickupTabCard";
import { PickupPage } from "./pages/PickupPage";
import { expireDueParcelHandoffs, loadState, peekStateRevision, visibleShipments } from "./services/storage";
import { onPlatformAccountsChanged } from "./services/platform-accounts";
import { canOpenParcelCabinet, performPickupAction, refreshPlatformParcels } from "./services/platform-parcel-sync";
import {
  diagnosticErrorDetails,
  diagnosticState,
  flushDiagnostics,
  writeDiagnostic,
  writeRuntimeCapabilities,
} from "./services/logger";
import { preferNewerState } from "./services/ui-state";
import { refreshAllShipments } from "./services/sync";
import {
  reloadAndRefreshOnResume,
  resumeShipmentId,
} from "./services/app-resume";
import { initializeCarrierAuthority } from "./services/carrier-authority";
import { startForegroundOrderProjection } from "./services/foreground-order-projection";
import { startForegroundRefresh } from "./services/foreground-return-refresh";
import { startStatusAlignment } from "./services/status-alignment";
import {
  PARCEL_SHORTCUT_RECORD_PARAMETER,
  discardShortcutDraft,
  nextSmsShortcutLookup,
  takeScreenShortcutLookup,
} from "./services/parcel-shortcut";
import {
  onParcelActivityPreviewChanged, parcelActivitySceneChanged, parcelActivityStatus, parcelActivityTarget,
  reconcileParcelActivity,
} from "./services/parcel-live-activity";
import { activePickupCards, independentPickupContent } from "./services/parcel-pickup";
import { nextParcelHandoffDeadline } from "./services/parcel-handoff-expiry";
import { reconcileFengchaoReminders } from "./services/fengchao-reminders";
import { transientToast } from "./services/ui-feedback";

type StartupState = {
  state: AppState | null;
};

function shortcutPickupRecordId(state: AppState | null, parameters: Readonly<Record<string, unknown>>): string {
  const id = parameters[PARCEL_SHORTCUT_RECORD_PARAMETER];
  const record = typeof id === "string" && state?.pickupCodeRecords?.find((item) => item.id === id);
  return record && independentPickupContent(record) ? record.id : "";
}

function readStartupState(): StartupState {
  try {
    return { state: loadState() };
  } catch (error) {
    writeDiagnostic(
      "app.startup.failed",
      diagnosticErrorDetails(error),
      "error",
    );
    return { state: null };
  }
}

function App() {
  // One app-owned viewport stays mounted across Home/detail navigation.
  const [projectionView, setProjectionView] = useState<ProjectionViewportView | null>(null);
  const [startup, setStartup] = useState(readStartupState);
  const settingsOverview = useSettingsOverview();
  const [platformRevision, setPlatformRevision] = useState(0);
  const [platformNotice, setPlatformNotice] = useState<{ text: string } | undefined>(undefined);
  const [pickupNotice, setPickupNotice] = useState("");
  const [navigationRequest, setNavigationRequest] = useState(() => {
    const parameters = Script.queryParameters || {};
    const activity = startup.state ? parcelActivityTarget(startup.state, parameters.parcelActivity) : undefined;
    const pickupRecordId = activity && "recordId" in activity ? activity.recordId :
      shortcutPickupRecordId(startup.state, parameters);
    return {
      shipmentId: activity && "shipmentId" in activity ? activity.shipmentId : resumeShipmentId({
        queryParameters: parameters,
        notificationInfo: Notification.current,
      }),
      pickupRecordId,
      shortcutLookup: takeScreenShortcutLookup(parameters) || (pickupRecordId ? undefined : nextSmsShortcutLookup()),
      generation: 0,
    };
  });
  const selection = useObservable<string>(
    navigationRequest.pickupRecordId ? "pickup" : "deliveries",
  );
  const state = startup.state;
  const revision = useRef(state?.revision ?? -1);
  revision.current = state?.revision ?? -1;
  const latestParcelState = useRef(state);
  latestParcelState.current = state;
  const shipments = useMemo(() => state ? visibleShipments(state) : [], [state]);
  const pickupCards = useMemo(() => activePickupCards(shipments, state?.pickupCodeRecords),
    [shipments, state?.pickupCodeRecords]);
  const [pickupPreview, setPickupPreview] = useState(false);
  const hasPickupTab = pickupCards.length > 0 || pickupPreview;
  useEffect(() => {
    if (hasPickupTab) void preparePickupBoxAnimation();
  }, [hasPickupTab]);
  const cabinetActions = useMemo(() => new Set(pickupCards.filter(canOpenParcelCabinet)),
    [platformRevision, pickupCards]);
  const handoffDeadline = useMemo(() => nextParcelHandoffDeadline(state?.pickupCodeRecords),
    [state?.pickupCodeRecords]);
  const query = Script.queryParameters || {};
  const focusSearch = String(query.focus || "") === "search";

  function applyState(next: AppState) {
    setStartup((current) => {
      const selected = current.state
        ? preferNewerState(current.state, next)
        : next;
      if (selected === current.state) return current;
      writeDiagnostic("app.state.applied", diagnosticState(selected));
      return { state: selected };
    });
  }

  function refreshPlatformList(mode: "observe" | "pull") {
    void refreshPlatformParcels(applyState, mode).then((result) => {
      if (result.added) setPlatformNotice({ text: `已新增 ${result.added} 件快递` });
    }).catch(() => {
      writeDiagnostic("platform.sync.unavailable", {}, "warning");
    });
  }

  useEffect(() => onPlatformAccountsChanged(() => setPlatformRevision((value) => value + 1)), []);
  useEffect(() => {
    let mounted = true;
    const reload = () => {
      void parcelActivityStatus().then(({ previewing }) => {
        if (mounted) setPickupPreview(previewing);
      }).catch(() => {
        writeDiagnostic("activity.parcel.preview.read.failed", { result: "failed" }, "warning");
      });
    };
    const unsubscribe = onParcelActivityPreviewChanged(reload);
    reload();
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);
  useEffect(() => {
    if (state) refreshPlatformList("observe");
  }, [state?.revision]);

  useEffect(() => {
    // While the app is on screen it captures JD order waybills by itself (Lite parity, 2026-09-24).
    const orderProjection = startForegroundOrderProjection({ applyState });
    // Returning to the foreground refreshes the list, debounced 2 minutes (user 2026-10-02「改成 2 分钟（三端一起）」;
    // 30 s before, user default #11, audit R4).
    const foregroundRefresh = startForegroundRefresh({ applyState });
    // A visible row whose status, headline and detail times are out of step is refreshed once, forced (user 2026-10-02).
    const statusAlignment = startStatusAlignment({ applyState });
    const observe = (phase: "active" | "inactive" | "background") => {
      writeDiagnostic("app.scene.changed", { result: phase });
      // Refresh flows open the union page only while the app is active (user 2026-09-25).
      setProjectionSceneActive(phase === "active");
      parcelActivitySceneChanged(phase);
      orderProjection.scenePhaseChanged(phase);
      foregroundRefresh.scenePhaseChanged(phase);
      statusAlignment.scenePhaseChanged(phase);
      if (phase === "active") {
        refreshPlatformList("observe");
        try {
          if (peekStateRevision() > revision.current) applyState(loadState());
          else if (latestParcelState.current) reconcileParcelActivity(latestParcelState.current);
          const lookup = nextSmsShortcutLookup();
          if (lookup) setNavigationRequest((current) => current.shortcutLookup ? current : {
            ...current,
            shortcutLookup: lookup,
            generation: current.generation + 1,
          });
        } catch {
          writeDiagnostic("app.shortcut.resume.failed", {}, "warning");
        }
      }
    };
    AppEvents.scenePhase.addListener(observe);
    return () => {
      AppEvents.scenePhase.removeListener(observe);
      orderProjection.stop();
      foregroundRefresh.stop();
      statusAlignment.stop();
    };
  }, []);

  useEffect(() => {
    if (state) {
      reconcileParcelActivity(state);
      void reconcileFengchaoReminders(state);
    }
  }, [state]);

  useEffect(() => {
    if (handoffDeadline === undefined) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let committed = false;
    function cancel() {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    }
    function schedule(deadline: number) {
      cancel();
      if (committed) return;
      timer = setTimeout(() => {
        timer = undefined;
        const now = Date.now();
        if (now < deadline) {
          schedule(deadline);
          return;
        }
        try {
          const next = expireDueParcelHandoffs(now);
          committed = true;
          applyState(next);
        } catch {
          writeDiagnostic("activity.parcel.expiry.failed", {}, "warning");
        }
      }, Math.min(2_147_483_647, Math.max(0, deadline - Date.now())));
    }
    const observe = (phase: "active" | "inactive" | "background") => {
      if (phase === "active") schedule(handoffDeadline);
      else cancel();
    };
    AppEvents.scenePhase.addListener(observe);
    schedule(handoffDeadline);
    return () => {
      cancel();
      AppEvents.scenePhase.removeListener(observe);
    };
  }, [handoffDeadline, state?.revision]);

  useEffect(() => {
    if (!hasPickupTab && selection.value === "pickup") selection.setValue("deliveries");
  }, [hasPickupTab]);

  useEffect(() => {
    return Script.onResume((details) => {
      void reloadAndRefreshOnResume(details, {
        load: loadState,
        onLoadFailed: (error) => {
          writeDiagnostic("app.resume.failed", diagnosticErrorDetails(error), "error");
          setStartup({ state: null });
        },
        applyPersisted: (persisted, shipmentId) => {
          const parameters = details.queryParameters || {};
          const screenLookup = takeScreenShortcutLookup(parameters);
          const activity = parcelActivityTarget(persisted, parameters.parcelActivity);
          const activityShipmentId = activity && "shipmentId" in activity ? activity.shipmentId : "";
          const pickupRecordId = activity && "recordId" in activity ? activity.recordId :
            shortcutPickupRecordId(persisted, parameters);
          const smsLookup = pickupRecordId ? undefined : nextSmsShortcutLookup();
          setStartup({ state: persisted });
          setNavigationRequest((current) => ({
            shipmentId: activityShipmentId || shipmentId,
            pickupRecordId,
            shortcutLookup: screenLookup || current.shortcutLookup || smsLookup,
            generation: current.generation + 1,
          }));
          if (pickupRecordId) selection.setValue("pickup");
          else if (screenLookup || activityShipmentId) selection.setValue("deliveries");
        },
        refresh: () => refreshAllShipments(),
        applyRefreshed: applyState,
      });
    });
  }, []);

  useEffect(() => {
    let mounted = true;
    const viewportHost = createProjectionViewportHost((view) => {
      if (mounted) setProjectionView(view);
    });
    registerProjectionViewportHost(viewportHost);
    return () => {
      mounted = false;
      registerProjectionViewportHost(null);
      viewportHost.unmount();
    };
  }, []);

  if (!state) {
    return (
      <NavigationStack>
        <List
          navigationTitle="派派助手"
          navigationBarTitleDisplayMode="large"
        >
          <Section header={<Text>本地数据暂不可用</Text>}>
            <Text>
              脚本没有覆盖现有数据。请稍后重试读取本地快递信息。
            </Text>
            <Button title="重试" action={() => setStartup(readStartupState())} />
          </Section>
        </List>
      </NavigationStack>
    );
  }

  return (
    <TabView
      selection={selection}
      toast={transientToast(pickupNotice, setPickupNotice)}
      background={
        projectionView
          ? {
              alignment: "topLeading",
              // Match Pipi's renderable capture surface while keeping it behind the app.
              content: (
                <GeometryReader>
                  {({ size }) => (
                    <ZStack>
                      {size.width > 0 && size.height > 0 ? (
                        <WebView key={projectionView.id}
                          controller={projectionView.controller}
                          frame={{ width: size.width, height: size.height }}
                          opacity={0.01}
                          allowsHitTesting={false}
                          disabled={true}
                          onAppear={projectionView.appeared}
                        />
                      ) : null}
                    </ZStack>
                  )}
                </GeometryReader>
              ),
            }
          : undefined
      }
    >
      {hasPickupTab ? (
        <Tab key="pickup" title="取件" systemImage="shippingbox.fill" value="pickup">
          <PickupPage
            state={state}
            shipments={shipments}
            cards={pickupCards}
            previewing={pickupPreview}
            focusedRecordId={navigationRequest.pickupRecordId}
            cabinetActions={cabinetActions}
            onStateChange={applyState}
            showNotice={setPickupNotice}
            onAction={(card, openCabinet) => performPickupAction(card, openCabinet, applyState)}
          />
        </Tab>
      ) : null}
      <Tab key="deliveries" title="快递" systemImage="archivebox.fill" value="deliveries">
        <HomePage
          state={state}
          shipments={shipments}
          autoFocusSearch={focusSearch || Boolean(navigationRequest.shortcutLookup)}
          initialShipmentId={navigationRequest.shipmentId}
          navigationRequestGeneration={navigationRequest.generation}
          shortcutLookup={navigationRequest.shortcutLookup}
          onShortcutHandled={(generation) => {
            if (generation !== navigationRequest.generation) return;
            const smsDraft = navigationRequest.shortcutLookup?.smsDraft;
            if (smsDraft) discardShortcutDraft(smsDraft);
            setNavigationRequest((current) =>
              current.generation === generation ? { ...current, shortcutLookup: undefined } : current);
          }}
          onStateChange={applyState}
          onListPull={() => refreshPlatformList("pull")}
          platformNotice={platformNotice}
        />
      </Tab>
      <Tab key="settings" title="设置" systemImage="gearshape.fill" value="settings">
        <SettingsPage state={state} pickupCards={pickupCards} overview={settingsOverview} onStateChange={applyState} />
      </Tab>
    </TabView>
  );
}

async function run() {
  // Without this the whole session ends on any throw with nothing recorded: `void run()` turns a
  // rejection into an unhandled one, the presented view is torn down, and the user sees the script
  // quit back to the app with an empty diagnostic log.
  try {
    initializeCarrierAuthority();
    writeRuntimeCapabilities("app");
    await Navigation.present({
      element: <App />,
      modalPresentationStyle: "fullScreen",
    });
  } catch (error) {
    writeDiagnostic(
      "app.session.failed",
      diagnosticErrorDetails(error),
      "error",
    );
  } finally {
    flushDiagnostics();
    Script.exit();
  }
}

void run();
