package me.pipi.deliveries.feature.express;

import static org.junit.Assert.assertEquals;
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
    public void manualQueryPrefersSubmittedThenPersistedCarrier() {
        assertEquals("SF", ExpressListActivity.manualQueryRawCarrierHint("SF", "JD"));
        assertEquals("JD", ExpressListActivity.manualQueryRawCarrierHint("", "JD"));
        assertEquals("", ExpressListActivity.manualQueryRawCarrierHint("", ""));
    }

    @Test
    public void detectedCarrierIsUsedOnlyForTheSameWaybill() {
        assertEquals("shunfeng", ExpressListActivity.detectedCarrierHintForQuery(
                "SF51152919462061", "SF51152919462061", "shunfeng"));
        assertEquals("SF", ExpressListActivity.detectedCarrierHintForQuery(
                " sf51152919462061 ", "SF51152919462061", " SF "));
        assertEquals("", ExpressListActivity.detectedCarrierHintForQuery(
                "SF51152919462062", "SF51152919462061", "shunfeng"));
    }

    @Test
    public void manualSubmitDefersOptionalCarrierDetectionUntilMotoRuns() throws Exception {
        String detail = projectFile("app/src/main/java/me/pipi/deliveries/feature/express/ExpressDetailActivity.java");
        String query = method(detail, "private void startFirstManualQuery()",
                "private boolean firstManualQueryIsCurrent(");
        int pickerFirst = query.indexOf("ManualQueryCoordinator.queryPickerFirst(");
        int detect = query.indexOf("manualApi.detect(", pickerFirst);
        int moto = query.indexOf("manualApi.queryMoto(", pickerFirst);
        assertTrue(pickerFirst >= 0);
        assertFalse(query.substring(0, pickerFirst).contains("manualApi.detect("));
        assertTrue(detect > pickerFirst);
        assertTrue(moto > detect);
        assertTrue(source().contains("detectedCarrierHintForQuery("));
        assertTrue(source().contains("ExpressDetailActivity.manualQueryIntent("));
        assertFalse(source().contains("saveManualQueryBatch("));
    }

    @Test
    public void leavingTheQueryDetailCancelsItsNetworkWorkAndLatePreview() throws Exception {
        String list = source();
        String detail = projectFile("app/src/main/java/me/pipi/deliveries/feature/express/ExpressDetailActivity.java");
        String onStop = method(detail, "protected void onStop()", "protected void onStart()");
        assertTrue(onStop.contains("cancelFirstManualQuery();"));
        assertTrue(detail.contains("firstManualQueryCancellation.cancel();"));
        assertTrue(detail.contains("firstManualQueryTask.cancel(true);"));
        assertTrue(detail.contains("if (!firstManualQueryIsCurrent(cancellation)) return;"));
        assertTrue(detail.contains("if (firstManualQueryIsCurrent(cancellation)) renderFirstManualResult(result);"));
        assertTrue(list.contains("result.getResultCode() == RESULT_OK"));
        assertTrue(list.contains("RESULT_PHONE_TAIL_REQUIRED"));
        assertTrue(list.contains("carrierDetectCancellation.cancel();"));
    }

    @Test
    public void homeEmptyStateReusesTheWidgetVehicleAndMinimalCopy() throws Exception {
        String layout = projectFile("app/src/main/res/layout/activity_express_list.xml");
        String strings = projectFile("app/src/main/res/values/strings.xml");
        String colors = projectFile("app/src/main/res/values/colors.xml");
        String nightColors = projectFile("app/src/main/res/values-night/colors.xml");
        int emptyStart = layout.indexOf("android:id=\"@+id/emptyView\"");
        int emptyEnd = layout.indexOf("</LinearLayout>", emptyStart);
        assertTrue(emptyStart >= 0);
        assertTrue(emptyEnd > emptyStart);
        String emptyState = layout.substring(emptyStart, emptyEnd);

        assertTrue(emptyState.contains("android:id=\"@+id/home_empty_group\""));
        assertTrue(emptyState.contains("android:layout_gravity=\"center\""));
        assertTrue(emptyState.contains("android:src=\"@drawable/widget_express_empty_vehicle\""));
        assertTrue(emptyState.contains("android:text=\"@string/widget_empty_message\""));
        assertTrue(emptyState.contains("android:maxLines=\"1\""));
        assertTrue(emptyState.contains("android:layout_width=\"81.6dp\""));
        assertTrue(emptyState.contains("android:layout_height=\"81.6dp\""));
        assertTrue(emptyState.contains("android:layout_marginTop=\"6dp\""));
        assertTrue(emptyState.contains("android:fontFamily=\"sans-serif-medium\""));
        assertTrue(emptyState.contains("android:textColor=\"@color/widget_empty_text\""));
        assertTrue(emptyState.contains("android:textSize=\"24sp\""));
        assertFalse(emptyState.contains("android:paddingBottom="));
        assertFalse(emptyState.contains("android:src=\"@drawable/widget_express_empty_box\""));
        assertFalse(emptyState.contains("android:tint=\"?attr/colorPrimary\""));
        assertTrue(strings.contains(
                "<string name=\"widget_empty_message\">暂无快递</string>"));
        assertTrue(colors.contains(
                "<color name=\"widget_empty_text\">#4D000000</color>"));
        assertTrue(nightColors.contains(
                "<color name=\"widget_empty_text\">#4DFFFFFF</color>"));
        assertFalse(strings.contains("<string name=\"no_express\""));
    }

    @Test
    public void searchSuffixOnlyShowsAResolvedCarrier() throws Exception {
        String source = source();
        String update = method(
                source, "private void updateCarrierSuffix(",
                "private void showPhoneTailDialog(");
        String query = method(
                source, "private void queryWaybill()",
                "private void scheduleCarrierDetection()");
        String strings = projectFile("app/src/main/res/values/strings.xml");

        assertTrue(update.contains("recognized ? value : \"\""));
        assertFalse(update.contains("carrier_auto_detect"));
        assertFalse(update.contains("carrier_detecting"));
        assertFalse(update.contains("carrier_unrecognized"));
        assertFalse(source.contains("R.string.carrier_auto_detect"));
        assertFalse(source.contains("R.string.carrier_detecting"));
        assertFalse(strings.contains("name=\"carrier_auto_detect\""));
        assertFalse(strings.contains("name=\"carrier_detecting\""));
        assertFalse(query.contains("isCarrierRecognitionFailure("));
        assertFalse(query.contains("R.string.carrier_unrecognized"));
        assertFalse(strings.contains("name=\"carrier_unrecognized\""));
        // 手动查件的结果文案走三端共享的 toast 表（AGENTS §11），strings.xml 不再保留副本。
        String detail = projectFile("app/src/main/java/me/pipi/deliveries/feature/express/ExpressDetailActivity.java");
        assertTrue(detail.contains("ExpressToastCopy.MANUAL_QUERY_TIMEOUT"));
        assertTrue(detail.contains("ExpressToastCopy.MANUAL_QUERY_FAILED"));
        assertFalse(strings.contains("name=\"manual_query_timeout\""));
        assertFalse(strings.contains("name=\"manual_query_failure\""));
    }

    @Test
    public void unavailableManualQueryQueuesHiddenRetryWithoutDisplayCarrierLeak()
            throws Exception {
        String detail = projectFile("app/src/main/java/me/pipi/deliveries/feature/express/ExpressDetailActivity.java");
        String failure = method(detail, "private void failFirstManualQuery(",
                "private void finishFirstManualQuery()");
        assertTrue(detail.contains("repository.enqueuePendingManual("));
        assertTrue(failure.contains("enqueuePendingManual(waybill, phone, bindingSource)"));
        assertTrue(failure.indexOf("needsPhoneTail()") < failure.indexOf("enqueuePendingManual("));
        assertTrue(failure.contains("RESULT_PHONE_TAIL_REQUIRED"));
        assertFalse(failure.contains("enqueuePendingManual(waybill, detectedCourierCode"));
    }

    @Test
    public void foregroundManualSuccessIsTheOnlyAutomaticDetailNavigation()
            throws Exception {
        String source = source();
        String query = method(
                source, "private void queryWaybill(String suppliedPhoneTail",
                "private void scheduleCarrierDetection()");
        String receiver = method(
                source, "private final BroadcastReceiver changes",
                "protected void onCreate(Bundle state)");
        String reload = method(
                source, "private void reload()",
                "private void startNextOrderProjectionCapture()");

        // Only an explicit submit opens the detail that owns this query; background sync never does.
        assertEquals(1, occurrences(query, "startActivity("));
        assertTrue(query.contains("manualQuery.launch(ExpressDetailActivity.manualQueryIntent("));
        assertFalse(query.contains("ExpressDetailActivity.transientPickerPreviewIntent("));
        assertFalse(receiver.contains("startActivity("));
        assertFalse(reload.contains("startActivity("));
    }

    @Test
    public void sevenDayNoticeIsANonSelectableScrollingListFooter() throws Exception {
        String source = source();
        String reload = method(
                source, "private void reload()",
                "private void startNextOrderProjectionCapture()");
        String layout = projectFile("app/src/main/res/layout/activity_express_list.xml");
        String footer = projectFile(
                "app/src/main/res/layout/footer_express_retention_notice.xml");
        String strings = projectFile("app/src/main/res/values/strings.xml");

        assertTrue(source.contains("private View retentionNotice;"));
        assertTrue(source.contains(
                "R.layout.footer_express_retention_notice, list, false"));
        assertTrue(source.contains("list.addFooterView(retentionNotice, null, false);"));
        assertTrue(source.indexOf("list.addFooterView(retentionNotice, null, false);")
                < source.indexOf("list.setAdapter(adapter);"));
        assertTrue(reload.contains(
                "retentionNotice.setVisibility(isEmpty ? View.GONE : View.VISIBLE);"));
        assertFalse(layout.contains("@+id/express_retention_notice"));
        assertTrue(footer.contains("android:text=\"@string/express_retention_notice\""));
        assertTrue(footer.contains(
                "android:textAppearance=\"@style/TextAppearance.Material3.BodySmall\""));
        assertTrue(footer.contains("android:textColor=\"?attr/colorOnSurfaceVariant\""));
        assertTrue(footer.contains("android:paddingTop=\"12dp\""));
        assertTrue(footer.contains("android:paddingBottom=\"12dp\""));
        assertTrue(footer.contains("android:visibility=\"gone\""));
        assertTrue(layout.contains("android:clipToPadding=\"false\""));
        assertTrue(layout.contains("android:paddingBottom=\"28dp\""));
        assertTrue(strings.contains(
                "<string name=\"express_retention_notice\">只显示 14 天内的快递信息</string>"));
    }

    private static String method(String source, String start, String next) {
        int startIndex = source.indexOf(start);
        int endIndex = source.indexOf(next, startIndex);
        assertTrue(startIndex >= 0);
        assertTrue(endIndex > startIndex);
        return source.substring(startIndex, endIndex);
    }

    private static int occurrences(String source, String value) {
        int count = 0;
        for (int index = source.indexOf(value); index >= 0;
                index = source.indexOf(value, index + value.length())) {
            count++;
        }
        return count;
    }

    private static String source() throws Exception {
        return projectFile("app/src/main/java/me/pipi/deliveries/feature/express/"
                + "ExpressListActivity.java");
    }

    private static String projectFile(String relative) throws Exception {
        Path path = Path.of(relative);
        if (!Files.isRegularFile(path)) path = Path.of(relative.substring("app/".length()));
        return Files.readString(path, StandardCharsets.UTF_8);
    }
}
