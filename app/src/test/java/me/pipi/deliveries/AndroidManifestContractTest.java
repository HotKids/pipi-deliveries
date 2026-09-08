package me.pipi.deliveries;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;
import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.Node;
import org.w3c.dom.NodeList;

import java.nio.file.Files;
import java.nio.file.Path;

import javax.xml.parsers.DocumentBuilderFactory;

/** Guards the app's intentional exported-component surface. */
public final class AndroidManifestContractTest {
    private static final String ANDROID_NAMESPACE = "http://schemas.android.com/apk/res/android";

    @Test
    public void onlySystemEntryActionsRemain() throws Exception {
        Document manifest = manifest();

        assertFalse(hasAction(manifest, "me.pipi.deliveries.action.EXPRESS_MORE"));
        assertFalse(hasAction(manifest, "me.pipi.deliveries.action.EXPRESS_BIND_PHONE"));
        assertFalse(hasAction(manifest, "me.pipi.deliveries.action.EXPRESS_QUERY"));

        Element launcher = component(manifest, "activity",
                "me.pipi.deliveries.feature.express.ExpressListActivity");
        assertTrue(hasNamedDescendant(launcher, "action", "android.intent.action.MAIN"));
        assertTrue(hasNamedDescendant(
                launcher, "category", "android.intent.category.LAUNCHER"));
        assertTrue(hasNamedDescendant(component(manifest, "receiver",
                        ".widget.Express2x2WidgetProvider"),
                "action", "android.appwidget.action.APPWIDGET_UPDATE"));
        assertTrue(hasNamedDescendant(component(manifest, "receiver",
                        ".widget.Express4x2WidgetProvider"),
                "action", "android.appwidget.action.APPWIDGET_UPDATE"));
    }

    @Test
    public void loginActivityIsPrivateAndLauncherRemainsExported() throws Exception {
        Document manifest = manifest();

        assertEquals("false", component(manifest, "activity",
                "me.pipi.deliveries.feature.express.ExpressLoginActivity")
                .getAttributeNS(ANDROID_NAMESPACE, "exported"));
        assertEquals("true", component(manifest, "activity",
                "me.pipi.deliveries.feature.express.ExpressListActivity")
                .getAttributeNS(ANDROID_NAMESPACE, "exported"));
    }

    private static Document manifest() throws Exception {
        DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
        factory.setNamespaceAware(true);
        return factory.newDocumentBuilder().parse(
                projectFile("app/src/main/AndroidManifest.xml").toFile());
    }

    private static Element component(Document document, String tag, String name) {
        NodeList nodes = document.getElementsByTagName(tag);
        for (int index = 0; index < nodes.getLength(); index++) {
            Element element = (Element) nodes.item(index);
            if (name.equals(element.getAttributeNS(ANDROID_NAMESPACE, "name"))) return element;
        }
        throw new AssertionError("Missing " + tag + ": " + name);
    }

    private static boolean hasAction(Document document, String name) {
        return hasNamedDescendant(document.getDocumentElement(), "action", name);
    }

    private static boolean hasNamedDescendant(Element root, String tag, String name) {
        NodeList nodes = root.getElementsByTagName(tag);
        for (int index = 0; index < nodes.getLength(); index++) {
            Node node = nodes.item(index);
            if (!(node instanceof Element)) continue;
            if (name.equals(((Element) node).getAttributeNS(ANDROID_NAMESPACE, "name"))) {
                return true;
            }
        }
        return false;
    }

    private static Path projectFile(String relative) {
        Path path = Path.of(relative);
        if (!Files.isRegularFile(path) && relative.startsWith("app/")) {
            path = Path.of(relative.substring("app/".length()));
        }
        return path;
    }
}
