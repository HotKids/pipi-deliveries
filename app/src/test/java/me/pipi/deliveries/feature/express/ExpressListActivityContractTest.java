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
    public void interactiveResultRequiresSameGenerationAndAccountSource() {
        assertTrue(ExpressListActivity.operationIsCurrent(
                7L, "interface6", 7L, "interface6"));
        assertFalse(ExpressListActivity.operationIsCurrent(
                7L, "interface6", 8L, "interface6"));
        assertFalse(ExpressListActivity.operationIsCurrent(
                7L, "interface6", 7L, "interface5"));
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
        String query = method(
                source(), "private void queryWaybill(String suppliedPhoneTail",
                "private void scheduleCarrierDetection()");

        int pickerFirst = query.indexOf("ManualQueryCoordinator.queryPickerFirst(");
        int detect = query.indexOf("manualApi.detect(", pickerFirst);
        int moto = query.indexOf("manualApi.queryMoto(", pickerFirst);
        assertTrue(pickerFirst >= 0);
        assertFalse(query.substring(0, pickerFirst).contains("manualApi.detect("));
        assertTrue(detect > pickerFirst);
        assertTrue(moto > detect);
        assertTrue(source().contains("detectedCarrierHintForQuery("));
    }

    /**
     * 页面 stop 只取消承运商识别，不取消手动查件：picker 一回来就开透明预览（另一个 Activity），
     * 列表页随即 onStop，原来把整条手动链连落库一起取消（Fold7 2026-09-05 三次「查完没进列表」）。
     * 页面销毁才全部取消。
     */
    @Test
    public void leavingTheListInvalidatesInteractiveNetworkWork() throws Exception {
        String source = source();
        String onStop = method(
                source, "protected void onStop()", "protected void onSaveInstanceState");
        String onDestroy = method(
                source, "protected void onDestroy()", "@Override");

        assertTrue(onStop.contains("invalidateCarrierDetection();"));
        assertFalse(onStop.contains("invalidateInteractiveNetworkOperations();"));
        assertTrue(onDestroy.contains("invalidateInteractiveNetworkOperations();"));
        assertTrue(source.contains("!queryOperationIsCurrent("));
        assertTrue(source.contains("!bindingSource.equals("));
        assertTrue(source.contains("ExpressAccountSource.bindingSource(this)"));
        assertTrue(source.contains("queryCancellation.cancel();"));
        assertTrue(source.contains("carrierDetectCancellation.cancel();"));
        assertTrue(source.contains("waybill, courierHint, operationCancellation)"));
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
        assertTrue(query.contains("ExpressToastCopy.MANUAL_QUERY_TIMEOUT"));
        assertTrue(query.contains("ExpressToastCopy.MANUAL_QUERY_FAILED"));
        assertFalse(strings.contains("name=\"manual_query_timeout\""));
        assertFalse(strings.contains("name=\"manual_query_failure\""));
    }

    @Test
    public void unavailableManualQueryQueuesHiddenRetryWithoutDisplayCarrierLeak()
            throws Exception {
        String source = source();
        String query = method(
                source, "private void queryWaybill(String suppliedPhoneTail",
                "private void scheduleCarrierDetection()");

        assertTrue(query.contains("repository.enqueuePendingManual("));
        assertTrue(query.contains("waybill, suppliedPhoneTail, queryBindingSource"));
        assertTrue(query.contains("!needsPhone"));
        assertFalse(query.contains(
                "enqueuePendingManual(waybill, detectedCourierCode"));
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

        // 用户定 2026-09-05：链跑完前不再开 K100 页的透明预览（每次搜索都打开那一页会用光当天配额），
        // 手动查件只剩「已在列表」和「查完落库」两处跳详情。
        // 已在列表 → 打开详情；京东来源已有起点 → 打开详情；查完落库 → 打开详情。
        assertEquals(3, occurrences(query, "startActivity("));
        assertFalse(query.contains("ExpressDetailActivity.transientPickerPreviewIntent("));
        assertTrue(query.contains("ExpressDetailActivity.persistedPreviewIntent("));
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
                "<string name=\"express_retention_notice\">只显示 7 天内的快递信息</string>"));
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
