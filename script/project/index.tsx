import {
  Button,
  List,
  Navigation,
  NavigationStack,
  Script,
  Section,
  Tab,
  TabView,
  Text,
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
import { requestWidgetReload } from "./services/widgets";

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
  const state = startup.state;
  const query = Script.queryParameters || {};
  const focusSearch = String(query.focus || "") === "search";
  const shipmentId = String(query.shipment || "");

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

  return (
    <TabView>
      <Tab title="快递" systemImage="shippingbox.fill" value="deliveries">
        <HomePage
          state={state}
          autoFocusSearch={focusSearch}
          initialShipmentId={shipmentId}
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
  requestWidgetReload();
  await Navigation.present({
    element: <App />,
    modalPresentationStyle: "fullScreen",
  });
  Script.exit();
}

void run();
