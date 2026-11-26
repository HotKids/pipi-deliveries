package me.pipi.deliveries.feature.express;

import android.content.Context;
import android.content.res.Configuration;
import androidx.core.graphics.ColorUtils;
import me.pipi.deliveries.data.CarrierRegistry;
import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.StatusSemantic;

/**
 * Parcel status colours shared by Lite's presentation surfaces. Owner 2026-11-20 (修改 11): lists,
 * details, the 寄 badge, notifications and the 2×2 headline show the shared non-capsule text pair as it
 * is; only the 4×2 status badge keeps a 3.0:1 floor where the carrier brand gradient causes the drop.
 */
public final class ExpressStatusColors {
    public static final double BRAND_GRADIENT_MIN_CONTRAST = 3.0;

    public static int accent(Context context, ExpressItem item) {
        return accent(item.semantic, item.displayStatus(), isNight(context));
    }

    public static int accent(StatusSemantic semantic, String label, boolean dark) {
        int selected = ExpressStatusTones.text(label, dark);
        if (selected == 0) {
            selected = ExpressStatusTones.text(CarrierRegistry.statusLabels().label(semantic), dark);
        }
        return selected != 0 ? selected : ExpressStatusTones.text("暂无状态", dark);
    }

    public static boolean isNight(Context context) {
        return (context.getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK)
                == Configuration.UI_MODE_NIGHT_YES;
    }

    public static int widgetBadgeBackground(ExpressItem item) {
        String label = item.displayStatus();
        if (ExpressStatusTones.text(label, false) == 0) {
            label = CarrierRegistry.statusLabels().label(item.semantic);
        }
        return ExpressStatusTones.widgetBadge(label);
    }

    public static int widgetBadgeFill(ExpressItem item) {
        return badgeFill(item.semantic, item.displayStatus());
    }

    /** The light text colour at 0x1A, in both appearances (the 寄 badge and the 4×2 status badge). */
    public static int badgeFill(StatusSemantic semantic, String label) {
        return (accent(semantic, label, false) & 0x00ffffff) | 0x1a000000;
    }

    /**
     * Owner 2026-11-20 (修改 11, rule 3): the 4×2 badge text stays as it is unless the carrier brand gradient
     * causes the drop, that is, its contrast at the brand corner (the 0x55 brand under the 0x1A badge fill)
     * is under 3.0:1 and lower than on the plain badge. Only then it takes the smallest 1% step toward black
     * or white that reaches 3.0:1 at that corner.
     */
    public static int brandGradientFloor(int text, int plain, int corner) {
        double atCorner = ColorUtils.calculateContrast(text, corner);
        if (atCorner >= BRAND_GRADIENT_MIN_CONTRAST
                || atCorner >= ColorUtils.calculateContrast(text, plain)) {
            return text;
        }
        int target = ColorUtils.calculateContrast(0xff000000, corner)
                >= ColorUtils.calculateContrast(0xffffffff, corner) ? 0xff000000 : 0xffffffff;
        for (int step = 1; step <= 100; step++) {
            int candidate = ColorUtils.setAlphaComponent(ColorUtils.blendARGB(text, target, step / 100f), 255);
            if (ColorUtils.calculateContrast(candidate, corner) >= BRAND_GRADIENT_MIN_CONTRAST) return candidate;
        }
        return target;
    }

    private ExpressStatusColors() {}
}
