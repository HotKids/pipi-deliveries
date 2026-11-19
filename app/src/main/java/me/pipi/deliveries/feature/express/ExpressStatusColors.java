package me.pipi.deliveries.feature.express;

import android.content.Context;
import android.content.res.Configuration;
import androidx.core.graphics.ColorUtils;
import me.pipi.deliveries.data.CarrierRegistry;
import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.StatusSemantic;

/** Parcel status accent and contrast shared by Lite's presentation surfaces. */
public final class ExpressStatusColors {
    public static int accent(Context context, ExpressItem item) {
        return accent(item.semantic, item.displayStatus(), isNight(context));
    }

    public static int accent(StatusSemantic semantic, String label, boolean dark) {
        int selected = ExpressStatusTones.accent(label, dark);
        if (selected == 0) {
            selected = ExpressStatusTones.accent(CarrierRegistry.statusLabels().label(semantic), dark);
        }
        return selected != 0 ? selected : ExpressStatusTones.accent("暂无状态", dark);
    }

    public static boolean isNight(Context context) {
        return (context.getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK)
                == Configuration.UI_MODE_NIGHT_YES;
    }

    public static int widgetBadgeBackground(ExpressItem item) {
        String label = item.displayStatus();
        if (ExpressStatusTones.accent(label, false) == 0) {
            label = CarrierRegistry.statusLabels().label(item.semantic);
        }
        return ExpressStatusTones.widgetBadge(label);
    }

    public static int widgetBadgeFill(ExpressItem item) {
        return (accent(item.semantic, item.displayStatus(), false) & 0x00ffffff) | 0x1a000000;
    }

    public static int textOn(int accent, int... backgrounds) {
        int target = minimumContrast(0xff000000, backgrounds) >= minimumContrast(0xffffffff, backgrounds)
                ? 0xff000000 : 0xffffffff;
        for (int step = 0; step <= 100; step++) {
            int candidate = ColorUtils.setAlphaComponent(ColorUtils.blendARGB(accent, target, step / 100f), 255);
            if (minimumContrast(candidate, backgrounds) >= 4.5) return candidate;
        }
        return target;
    }

    private static double minimumContrast(int color, int[] backgrounds) {
        double minimum = Double.POSITIVE_INFINITY;
        for (int background : backgrounds) {
            minimum = Math.min(minimum, ColorUtils.calculateContrast(color, background));
        }
        return minimum;
    }

    private ExpressStatusColors() {}
}
