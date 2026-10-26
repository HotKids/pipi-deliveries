package me.pipi.deliveries.notification;

import java.util.ArrayList;
import java.util.List;
import me.pipi.deliveries.R;
import me.pipi.deliveries.data.CarrierRegistry;
import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.ExpressTimeline;
import me.pipi.deliveries.model.StatusSemantic;
import me.pipi.deliveries.widget.ExpressWidgetPresentation;

/** Pipi's no-pickup-code presentation, using Lite's existing visible status policy. */
final class ExpressLivePresentation {
    final ExpressItem primary;
    final String title, capsule, summary, detail;
    final int smallIcon, accent, labelLength;

    private ExpressLivePresentation(ExpressItem primary, String label, int count) {
        this.primary = primary;
        labelLength = label.length();
        title = label + " " + count + " 件";
        capsule = label + " " + count;
        boolean waiting = primary.semantic == StatusSemantic.WAITING_PICKUP;
        smallIcon = waiting ? R.drawable.ic_live_package : R.drawable.ic_live_delivery;
        accent = ExpressNotifications.statusColor(primary.semantic);
        String company = primary.displayCarrierLabel();
        String waybill = primary.displayWaybill();
        String suffix = waybill.length() <= 4 ? waybill : waybill.substring(waybill.length() - 4);
        summary = waiting ? "📦  " + company + (suffix.isEmpty() ? "" : " " + suffix)
                : company + (waybill.isEmpty() ? "" : " · " + waybill);
        String headline = ExpressTimeline.displayHeadline(primary);
        detail = waiting && !headline.isEmpty() ? "🚚  " + headline : headline;
    }

    static ExpressLivePresentation from(List<ExpressItem> visible, boolean delivery, boolean pickup) {
        List<ExpressItem> candidates = new ArrayList<>();
        if (visible != null) for (ExpressItem item : visible) {
            if (item == null || item.carrierPending()) continue;
            if (item.semantic == StatusSemantic.DELIVERY && !delivery) continue;
            if (item.semantic == StatusSemantic.WAITING_PICKUP && !pickup) continue;
            candidates.add(item);
        }
        List<ExpressItem> sorted = ExpressWidgetPresentation.sorted(candidates);
        if (sorted.isEmpty()) return null;
        ExpressItem primary = sorted.get(0);
        if (primary.semantic != StatusSemantic.WAITING_PICKUP
                && primary.semantic != StatusSemantic.DELIVERY) return null;
        int count = 0;
        String label = primary.displayStatus();
        boolean sameLabel = true;
        for (ExpressItem item : sorted) if (item.semantic == primary.semantic) {
            count++;
            sameLabel &= label.equals(item.displayStatus());
        }
        if (!sameLabel) label = CarrierRegistry.statusLabels().label(primary.semantic);
        return new ExpressLivePresentation(primary, label, count);
    }

    String fingerprint() {
        return NotificationDismissalStore.fingerprint(primary.rowId, primary.semantic.name(), title,
                capsule, summary, detail);
    }
}
