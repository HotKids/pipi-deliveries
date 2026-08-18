package me.pipi.deliveries.feature.express;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

/** Guards dialogs that are owned directly by the list activity rather than a DialogFragment. */
public final class ExpressListActivityContractTest {
    @Test
    public void ownedDialogsAreDismissedWithTheActivity() throws Exception {
        String source = source();
        String onDestroy = method(source, "protected void onDestroy()", "private void reload()");

        assertTrue(source.contains("private Dialog phoneTailDialog;"));
        assertTrue(source.contains("private Dialog deleteConfirmationDialog;"));
        assertTrue(source.contains("phoneTailDialog = dialog;"));
        assertTrue(source.contains("deleteConfirmationDialog = dialog;"));
        assertTrue(onDestroy.contains("dismissDialog(phoneTailDialog);"));
        assertTrue(onDestroy.contains("dismissDialog(deleteConfirmationDialog);"));
    }

    @Test
    public void phoneTailDialogStateIsSavedAndRestored() throws Exception {
        String source = source();
        String save = method(
                source, "protected void onSaveInstanceState(Bundle state)",
                "protected void onDestroy()");

        assertTrue(save.contains("STATE_PHONE_TAIL_DIALOG"));
        assertTrue(save.contains("STATE_PHONE_TAIL_VALUE"));
        assertTrue(source.contains("state.getString(STATE_PHONE_TAIL_VALUE, \"\")"));
    }

    @Test
    public void interactiveResultRequiresSameGenerationAndAccountSource() {
        assertTrue(ExpressListActivity.operationIsCurrent(
                7L, "interface6", 7L, "interface6"));
        assertFalse(ExpressListActivity.operationIsCurrent(
                7L, "interface6", 8L, "interface6"));
        assertFalse(ExpressListActivity.operationIsCurrent(
                7L, "interface6", 7L, "interface5"));
    }

    @Test
    public void leavingTheListInvalidatesInteractiveNetworkWork() throws Exception {
        String source = source();
        String onStop = method(
                source, "protected void onStop()", "protected void onSaveInstanceState");

        assertTrue(onStop.contains("invalidateInteractiveNetworkOperations();"));
        assertTrue(source.contains("!queryOperationIsCurrent("));
        assertTrue(source.contains("!bindingSource.equals("));
        assertTrue(source.contains("ExpressAccountSource.bindingSource(this)"));
        assertTrue(source.contains("queryCancellation.cancel();"));
        assertTrue(source.contains("carrierDetectCancellation.cancel();"));
        assertTrue(source.contains("operationCancellation));"));
    }

    private static String method(String source, String start, String next) {
        int startIndex = source.indexOf(start);
        int endIndex = source.indexOf(next, startIndex);
        assertTrue(startIndex >= 0);
        assertTrue(endIndex > startIndex);
        return source.substring(startIndex, endIndex);
    }

    private static String source() throws Exception {
        String relative = "app/src/main/java/me/pipi/deliveries/feature/express/"
                + "ExpressListActivity.java";
        Path path = Path.of(relative);
        if (!Files.isRegularFile(path)) path = Path.of(relative.substring("app/".length()));
        return Files.readString(path, StandardCharsets.UTF_8);
    }
}
