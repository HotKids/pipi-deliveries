package me.pipi.deliveries.widget;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

import java.util.Arrays;
import java.util.List;

import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.StatusSemantic;

public final class ExpressWidgetPresentationTest {
    @Test
    public void countsOnlyActiveAndWaitingItems() {
        List<ExpressItem> items = Arrays.asList(
                item(1, StatusSemantic.WAITING_PICKUP),
                item(2, StatusSemantic.TRANSIT),
                item(3, StatusSemantic.COMPLETED),
                item(4, StatusSemantic.CANCELLED));

        assertEquals(2, ExpressWidgetPresentation.activeCount(items));
        assertEquals(1, ExpressWidgetPresentation.waitingCount(items));
    }

    @Test
    public void compactHeadlineUsesRequestedStatusPriority() {
        ExpressWidgetPresentation.PriorityStatus waiting =
                ExpressWidgetPresentation.priorityStatus(Arrays.asList(
                        item(1, StatusSemantic.COMPLETED),
                        item(2, StatusSemantic.TRANSIT),
                        item(3, StatusSemantic.WAITING_PICKUP)));
        assertEquals(StatusSemantic.WAITING_PICKUP, waiting.semantic);
        assertEquals(1, waiting.count);

        ExpressWidgetPresentation.PriorityStatus transit =
                ExpressWidgetPresentation.priorityStatus(Arrays.asList(
                        item(4, StatusSemantic.PICKED),
                        item(5, StatusSemantic.TRANSIT),
                        item(6, StatusSemantic.COMPLETED)));
        assertEquals(StatusSemantic.TRANSIT, transit.semantic);
        assertEquals(1, transit.count);

        ExpressWidgetPresentation.PriorityStatus completed =
                ExpressWidgetPresentation.priorityStatus(Arrays.asList(
                        item(7, StatusSemantic.COMPLETED),
                        item(8, StatusSemantic.COMPLETED)));
        assertEquals(StatusSemantic.COMPLETED, completed.semantic);
        assertEquals(2, completed.count);
    }

    @Test
    public void compactHeadlineOmitsProblemUnknownAndCancelledStates() {
        ExpressWidgetPresentation.PriorityStatus status =
                ExpressWidgetPresentation.priorityStatus(Arrays.asList(
                        item(1, StatusSemantic.DANGER),
                        item(2, StatusSemantic.UNKNOWN),
                        item(3, StatusSemantic.CANCELLED)));

        assertEquals(StatusSemantic.UNKNOWN, status.semantic);
        assertEquals(0, status.count);
    }

    @Test
    public void compactHeadlineUsesPipiPriorityAndCanonicalLabels() {
        StatusSemantic[] priority = {
                StatusSemantic.WAITING_PICKUP,
                StatusSemantic.DELIVERY,
                StatusSemantic.TRANSIT,
                StatusSemantic.PICKED,
                StatusSemantic.SHIPPED,
                StatusSemantic.ORDERED,
                StatusSemantic.COMPLETED
        };
        // Audit L5 (user defaults 2026-09-25): the word comes from the one status label table
        // (these used to be widget-only string resources with the same words).
        String[] labels = {"待取件", "派送中", "运输中", "已揽件", "已发货", "已下单", "已签收"};

        for (int index = 0; index < priority.length; index++) {
            ExpressItem[] remaining = new ExpressItem[priority.length - index];
            for (int offset = 0; offset < remaining.length; offset++) {
                remaining[offset] = item(offset + 1L, priority[index + offset]);
            }
            ExpressWidgetPresentation.PriorityStatus selected =
                    ExpressWidgetPresentation.priorityStatus(Arrays.asList(remaining));
            assertEquals(priority[index], selected.semantic);
            assertEquals(1, selected.count);
            assertEquals(labels[index],
                    ExpressWidgetPresentation.statusText(item(1L, priority[index])));
        }
    }

    @Test
    public void widgetStatusLabelsMatchPipiForEverySemantic() {
        StatusSemantic[] semantics = {
                StatusSemantic.WAITING_PICKUP,
                StatusSemantic.DELIVERY,
                StatusSemantic.TRANSIT,
                StatusSemantic.PICKED,
                StatusSemantic.SHIPPED,
                StatusSemantic.ORDERED,
                StatusSemantic.COMPLETED,
                StatusSemantic.DANGER,
                StatusSemantic.UNKNOWN,
                StatusSemantic.CANCELLED
        };
        String[] labels = {"待取件", "派送中", "运输中", "已揽件", "已发货", "已下单", "已签收",
                "异常件", "暂无状态", "已取消"};

        for (int index = 0; index < semantics.length; index++) {
            ExpressItem item = item(1L, semantics[index]);
            assertEquals(labels[index], ExpressWidgetPresentation.statusText(item));
            assertEquals("the widget word is the list word", item.displayStatus(),
                    ExpressWidgetPresentation.statusText(item));
        }
    }

    @Test
    public void compactHeadlineKeepsUnprojectedOrdersAsOrdered() {
        ExpressWidgetPresentation.PriorityStatus ordered =
                ExpressWidgetPresentation.priorityStatus(Arrays.asList(
                        item(1, StatusSemantic.ORDERED),
                        item(2, StatusSemantic.ORDERED)));

        assertEquals(StatusSemantic.ORDERED, ordered.semantic);
        assertEquals(2, ordered.count);
        assertEquals("已下单", ExpressWidgetPresentation.statusText(item(1L, ordered.semantic)));
    }

    @Test
    public void sortsAllStatesByPipiStatusPriorityWithoutTruncatingCollection() {
        List<ExpressItem> sorted = ExpressWidgetPresentation.sorted(Arrays.asList(
                item(1, StatusSemantic.COMPLETED),
                item(2, StatusSemantic.CANCELLED),
                item(3, StatusSemantic.UNKNOWN),
                item(4, StatusSemantic.DANGER),
                item(5, StatusSemantic.ORDERED),
                item(6, StatusSemantic.SHIPPED),
                item(7, StatusSemantic.PICKED),
                item(8, StatusSemantic.TRANSIT),
                item(9, StatusSemantic.DELIVERY),
                item(10, StatusSemantic.WAITING_PICKUP)));
        StatusSemantic[] expected = {
                StatusSemantic.WAITING_PICKUP,
                StatusSemantic.DELIVERY,
                StatusSemantic.TRANSIT,
                StatusSemantic.PICKED,
                StatusSemantic.SHIPPED,
                StatusSemantic.ORDERED,
                StatusSemantic.DANGER,
                StatusSemantic.UNKNOWN,
                StatusSemantic.CANCELLED,
                StatusSemantic.COMPLETED
        };

        assertEquals(expected.length, sorted.size());
        for (int index = 0; index < expected.length; index++) {
            assertEquals(expected[index], sorted.get(index).semantic);
        }
    }

    @Test
    public void limitsCollectionAfterApplyingStatusPriority() {
        List<ExpressItem> selected = ExpressWidgetPresentation.first(Arrays.asList(
                item(1, StatusSemantic.COMPLETED),
                item(2, StatusSemantic.TRANSIT),
                item(3, StatusSemantic.WAITING_PICKUP),
                item(4, StatusSemantic.DELIVERY)), 3);

        assertEquals(3, selected.size());
        assertEquals(StatusSemantic.WAITING_PICKUP, selected.get(0).semantic);
        assertEquals(StatusSemantic.DELIVERY, selected.get(1).semantic);
        assertEquals(StatusSemantic.TRANSIT, selected.get(2).semantic);
    }

    @Test
    public void formatsPipiWidgetStatusLine() {
        ExpressItem item = new ExpressItem(
                7, "", "79000000000001", "ZTO", "中通快递",
                StatusSemantic.WAITING_PICKUP, "待取件", "", "", "", "", "INTERFACE5", "");

        assertEquals("中通快递 0001 · 待取件", ExpressWidgetPresentation.rowTitle(item));
        assertEquals("中通快递 0001", ExpressWidgetPresentation.rowIdentity(item));
    }

    /**
     * Audit L5 (user defaults 2026-09-25): the widget shows the list's word, not a fixed widget copy
     * — an order that completed without a real waybill reads 已完成 on the list, so it does on the
     * widget too (it used to read 已签收 there); the 待派送 subtype (STA_DELIVERING) likewise.
     */
    @Test
    public void theWidgetShowsTheListWordForOrdersAndSubtypes() throws Exception {
        ExpressItem order = new ExpressItem(1L, "", "3610448002878202", "JDKD", "京东商品快递",
                StatusSemantic.COMPLETED, "", "", "", "[]", "", "I5-JD", "", 1L, 1L, "I5-JD", "");
        assertEquals("已完成", order.displayStatus());
        assertEquals("已完成", ExpressWidgetPresentation.statusText(order));

        String station = me.pipi.deliveries.model.WorkerStatusProjection.attach("[]",
                me.pipi.deliveries.model.WorkerStatusProjection.read(new org.json.JSONObject()
                        .put("normalizedStatus", new org.json.JSONObject().put("version", 1)
                                .put("scope", "SHIPMENT").put("semantic", "DELIVERY")
                                .put("code", "STA_DELIVERING").put("text", "驿站派送中")
                                .put("priority", 1).put("eventAtMs", 5L).put("structured", true))));
        ExpressItem parcel = new ExpressItem(2L, "", "YT7000000000001", "YTO", "圆通速递",
                StatusSemantic.DELIVERY, "", "", "", station, "", "INTERFACE5", "", 5L, 5L,
                "INTERFACE5", "");
        assertEquals("待派送", ExpressWidgetPresentation.statusText(parcel));
    }

    private static ExpressItem item(long id, StatusSemantic semantic) {
        return new ExpressItem(
                id, "", Long.toString(id), "", "快递", semantic,
                semantic.label, "", "", "", "", "INTERFACE5", "");
    }
}
