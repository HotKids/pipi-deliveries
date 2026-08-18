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
    public void compactHeadlineNeverInventsWaitingPickupForRemainingStates() {
        ExpressWidgetPresentation.PriorityStatus danger =
                ExpressWidgetPresentation.priorityStatus(Arrays.asList(
                        item(1, StatusSemantic.DANGER)));
        ExpressWidgetPresentation.PriorityStatus unknown =
                ExpressWidgetPresentation.priorityStatus(Arrays.asList(
                        item(2, StatusSemantic.UNKNOWN)));
        ExpressWidgetPresentation.PriorityStatus cancelled =
                ExpressWidgetPresentation.priorityStatus(Arrays.asList(
                        item(3, StatusSemantic.CANCELLED)));

        assertEquals(StatusSemantic.DANGER, danger.semantic);
        assertEquals(1, danger.count);
        assertEquals(StatusSemantic.UNKNOWN, unknown.semantic);
        assertEquals(1, unknown.count);
        assertEquals(StatusSemantic.CANCELLED, cancelled.semantic);
        assertEquals(1, cancelled.count);
        assertEquals(me.pipi.deliveries.R.string.widget_status_danger,
                ExpressWidgetPresentation.priorityLabel(danger.semantic));
        assertEquals(me.pipi.deliveries.R.string.widget_status_unknown,
                ExpressWidgetPresentation.priorityLabel(unknown.semantic));
        assertEquals(me.pipi.deliveries.R.string.widget_status_cancelled,
                ExpressWidgetPresentation.priorityLabel(cancelled.semantic));
    }

    @Test
    public void sortsByPipiStatusPriorityWithoutTruncatingCollection() {
        List<ExpressItem> sorted = ExpressWidgetPresentation.sorted(Arrays.asList(
                item(1, StatusSemantic.COMPLETED),
                item(2, StatusSemantic.TRANSIT),
                item(3, StatusSemantic.WAITING_PICKUP),
                item(4, StatusSemantic.DELIVERY)));

        assertEquals(4, sorted.size());
        assertEquals(StatusSemantic.WAITING_PICKUP, sorted.get(0).semantic);
        assertEquals(StatusSemantic.DELIVERY, sorted.get(1).semantic);
        assertEquals(StatusSemantic.TRANSIT, sorted.get(2).semantic);
        assertEquals(StatusSemantic.COMPLETED, sorted.get(3).semantic);
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
    }

    private static ExpressItem item(long id, StatusSemantic semantic) {
        return new ExpressItem(
                id, "", Long.toString(id), "", "快递", semantic,
                semantic.label, "", "", "", "", "INTERFACE5", "");
    }
}
