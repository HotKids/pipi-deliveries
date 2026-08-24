package me.pipi.deliveries.widget;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

import me.pipi.deliveries.R;
import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.StatusSemantic;

/** Pure presentation policy shared by the express widgets. */
final class ExpressWidgetPresentation {
    private static final StatusSemantic[] COMPACT_STATUS_PRIORITY = {
            StatusSemantic.WAITING_PICKUP,
            StatusSemantic.DELIVERY,
            StatusSemantic.TRANSIT,
            StatusSemantic.PICKED,
            StatusSemantic.SHIPPED,
            StatusSemantic.ORDERED,
            StatusSemantic.COMPLETED
    };

    private ExpressWidgetPresentation() {}

    static final class PriorityStatus {
        final StatusSemantic semantic;
        final int count;

        PriorityStatus(StatusSemantic semantic, int count) {
            this.semantic = semantic;
            this.count = count;
        }
    }

    static int activeCount(List<ExpressItem> items) {
        int count = 0;
        for (ExpressItem item : items) {
            if (!item.semantic.terminal()) count++;
        }
        return count;
    }

    static int waitingCount(List<ExpressItem> items) {
        int count = 0;
        for (ExpressItem item : items) {
            if (item.semantic == StatusSemantic.WAITING_PICKUP) count++;
        }
        return count;
    }

    /** Mirrors Pipi's compact metric priority and omits non-metric states. */
    static PriorityStatus priorityStatus(List<ExpressItem> items) {
        for (StatusSemantic semantic : COMPACT_STATUS_PRIORITY) {
            int count = 0;
            for (ExpressItem item : items) {
                if (item.semantic == semantic) {
                    count++;
                }
            }
            if (count > 0) return new PriorityStatus(semantic, count);
        }
        return new PriorityStatus(StatusSemantic.UNKNOWN, 0);
    }

    static int priorityLabel(StatusSemantic semantic) {
        switch (semantic) {
            case DELIVERY: return R.string.widget_status_delivery;
            case TRANSIT: return R.string.widget_status_transit;
            case PICKED: return R.string.widget_status_picked;
            case SHIPPED: return R.string.widget_status_shipped;
            case ORDERED: return R.string.widget_status_ordered;
            case COMPLETED: return R.string.widget_status_completed;
            case DANGER: return R.string.widget_status_danger;
            case UNKNOWN: return R.string.widget_status_unknown;
            case CANCELLED: return R.string.widget_status_cancelled;
            case WAITING_PICKUP:
            default: return R.string.widget_status_waiting;
        }
    }

    static List<ExpressItem> sorted(List<ExpressItem> items) {
        ArrayList<ExpressItem> sorted = new ArrayList<>(items);
        // Stable sort preserves the repository's newest-first order inside each state.
        sorted.sort(Comparator.comparingInt(item -> rank(item.semantic)));
        return sorted;
    }

    static List<ExpressItem> first(List<ExpressItem> items, int limit) {
        List<ExpressItem> sorted = sorted(items);
        if (sorted.size() <= limit) return sorted;
        return new ArrayList<>(sorted.subList(0, limit));
    }

    static String suffix(String waybill) {
        if (waybill == null) return "";
        String value = waybill.trim();
        return value.length() <= 4 ? value : value.substring(value.length() - 4);
    }

    static String rowTitle(ExpressItem item) {
        String suffix = suffix(item.displayWaybill());
        String meta = suffix.isEmpty()
                ? item.displayStatus() : suffix + " · " + item.displayStatus();
        return item.displayCompany() + " " + meta;
    }

    static String rowIdentity(ExpressItem item) {
        String suffix = suffix(item.displayWaybill());
        return suffix.isEmpty() ? item.displayCompany()
                : item.displayCompany() + " " + suffix;
    }

    private static int rank(StatusSemantic semantic) {
        switch (semantic) {
            case WAITING_PICKUP: return 0;
            case DELIVERY: return 1;
            case TRANSIT: return 2;
            case PICKED: return 3;
            case SHIPPED: return 4;
            case ORDERED: return 5;
            case DANGER: return 6;
            case UNKNOWN: return 7;
            case CANCELLED: return 8;
            case COMPLETED: return 9;
            default: return 10;
        }
    }
}
