package me.pipi.deliveries.widget;

import android.appwidget.AppWidgetManager;
import android.content.Context;
import android.content.res.Configuration;
import android.os.Bundle;

/** Shared launcher-size decoding for express RemoteViews surfaces. */
final class WidgetHostMetrics {
    private WidgetHostMetrics() {}

    static float currentWidthDp(Context context, Bundle options) {
        int min = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 250);
        int max = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_WIDTH, min);
        return context.getResources().getConfiguration().orientation
                == Configuration.ORIENTATION_LANDSCAPE ? max : min;
    }

    static float currentHeightDp(Context context, Bundle options) {
        int min = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 180);
        int max = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, min);
        return context.getResources().getConfiguration().orientation
                == Configuration.ORIENTATION_LANDSCAPE ? min : max;
    }
}
