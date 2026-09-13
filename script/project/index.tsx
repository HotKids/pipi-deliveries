import {
  Button,
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
  useEffect,
  useRef,
  useState,
} from "scripting";
import { registerProjectionViewportHost } from "./services/projection-viewport";
import type { AppState } from "./models";
import { HomePage } from "./pages/HomePage";
import { SettingsPage } from "./pages/SettingsPage";
import { loadState } from "./services/storage";
import {
  diagnosticErrorDetails,
  diagnosticState,
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

type StartupState = {
  state: AppState | null;
};

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
  const [projectionController, setProjectionController] = useState<unknown>(null);
  const projectionMountRef = useRef<Array<(mounted: boolean) => void>>([]);
  const [startup, setStartup] = useState(readStartupState);
  const [navigationRequest, setNavigationRequest] = useState(() => ({
    shipmentId: resumeShipmentId({
      queryParameters: Script.queryParameters || {},
      notificationInfo: Notification.current,
    }),
    generation: 0,
  }));
  const state = startup.state;
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

  useEffect(() => {
    const observe = (phase: "active" | "inactive" | "background") => {
      writeDiagnostic("app.scene.changed", { result: phase });
    };
    AppEvents.scenePhase.addListener(observe);
    return () => AppEvents.scenePhase.removeListener(observe);
  }, []);

  useEffect(() => {
    return Script.onResume((details) => {
      void reloadAndRefreshOnResume(details, {
        load: loadState,
        applyPersisted: (persisted, shipmentId) => {
          setStartup({ state: persisted });
          setNavigationRequest((current) => ({
            shipmentId,
            generation: current.generation + 1,
          }));
        },
        refresh: () => refreshAllShipments(),
        applyRefreshed: applyState,
      });
    });
  }, []);

  useEffect(() => {
    const settle = (mounted: boolean) => {
      const pending = projectionMountRef.current.splice(0);
      pending.forEach((resolve) => resolve(mounted));
    };
    registerProjectionViewportHost({
      mount: (controller) =>
        new Promise<boolean>((resolve) => {
          projectionMountRef.current.push(resolve);
          setProjectionController(controller);
        }),
      unmount: () => {
        settle(false);
        setProjectionController(null);
      },
    });
    return () => {
      // Dismissal releases any projection still waiting for its viewport.
      registerProjectionViewportHost(null);
      settle(false);
    };
  }, []);

  useEffect(() => {
    if (!projectionController) return;
    // The slot is on screen now, so the borrower may start loading.
    projectionMountRef.current.splice(0).forEach((resolve) => resolve(true));
  }, [projectionController]);

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
      background={
        projectionController
          ? {
              alignment: "topLeading",
              // Fully transparent, non-interactive and behind every row: the page only lends
              // its bounds to both Home and detail captures (AGENTS §9).
              content: (
                <WebView
                  controller={projectionController}
                  frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
                  opacity={0}
                  disabled={true}
                />
              ),
            }
          : undefined
      }
    >
      <Tab title="快递" systemImage="shippingbox.fill" value="deliveries">
        <HomePage
          state={state}
          autoFocusSearch={focusSearch}
          initialShipmentId={navigationRequest.shipmentId}
          navigationRequestGeneration={navigationRequest.generation}
          onStateChange={applyState}
        />
      </Tab>
      <Tab title="设置" systemImage="gearshape.fill" value="settings">
        <SettingsPage state={state} onStateChange={applyState} />
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
    Script.exit();
  }
}

void run();
