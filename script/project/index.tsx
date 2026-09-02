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
  useEffect,
  useState,
} from "scripting";
import type { AppState } from "./models";
import { HomePage } from "./pages/HomePage";
import { SettingsPage } from "./pages/SettingsPage";
import { loadState } from "./services/storage";
import {
  diagnosticErrorDetails,
  diagnosticState,
  writeDiagnostic,
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
    <TabView>
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
  initializeCarrierAuthority();
  await Navigation.present({
    element: <App />,
    modalPresentationStyle: "fullScreen",
  });
  Script.exit();
}

void run();
