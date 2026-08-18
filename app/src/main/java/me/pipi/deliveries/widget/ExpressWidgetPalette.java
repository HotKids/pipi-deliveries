package me.pipi.deliveries.widget;

import android.content.Context;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.Build;

import java.util.concurrent.ConcurrentHashMap;

import me.pipi.deliveries.model.ExpressItem;

/** Wallpaper-derived Material accent shared by both widget empty states. */
final class ExpressWidgetPalette {
    private static final int FALLBACK_ACCENT = 0xff3482ff;
    private static final ConcurrentHashMap<Integer, Integer> ACCENTS =
            new ConcurrentHashMap<>();

    private ExpressWidgetPalette() {}

    static int emptyAccent(Context context) {
        if (context == null) return FALLBACK_ACCENT;
        boolean night = (context.getResources().getConfiguration().uiMode
                & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        if (Build.VERSION.SDK_INT < 31) return FALLBACK_ACCENT;
        try {
            return context.getResources().getColor(
                    night ? android.R.color.system_accent1_200
                            : android.R.color.system_accent1_600,
                    null);
        } catch (Throwable ignored) {
            return FALLBACK_ACCENT;
        }
    }

    static int accent(Context context, ExpressItem item) {
        if (context == null || item == null) return FALLBACK_ACCENT;
        int resource = item.displayIconResource();
        Integer cached = ACCENTS.get(resource);
        if (cached != null) return cached;
        Bitmap bitmap = null;
        int accent = FALLBACK_ACCENT;
        try {
            bitmap = BitmapFactory.decodeResource(context.getResources(), resource);
            if (bitmap != null && bitmap.getWidth() > 0 && bitmap.getHeight() > 0) {
                int[] pixels = new int[bitmap.getWidth() * bitmap.getHeight()];
                bitmap.getPixels(pixels, 0, bitmap.getWidth(), 0, 0,
                        bitmap.getWidth(), bitmap.getHeight());
                accent = dominantAccent(pixels, FALLBACK_ACCENT);
            }
        } catch (Throwable ignored) {
            accent = FALLBACK_ACCENT;
        } finally {
            if (bitmap != null && !bitmap.isRecycled()) bitmap.recycle();
        }
        ACCENTS.putIfAbsent(resource, accent);
        return ACCENTS.get(resource);
    }

    static int dominantAccent(int[] pixels, int fallback) {
        if (pixels == null || pixels.length == 0) return fallback;
        long[] weights = new long[512];
        long[] reds = new long[512];
        long[] greens = new long[512];
        long[] blues = new long[512];
        for (int pixel : pixels) {
            int alpha = pixel >>> 24;
            if (alpha < 64) continue;
            int red = (pixel >>> 16) & 0xff;
            int green = (pixel >>> 8) & 0xff;
            int blue = pixel & 0xff;
            int maximum = Math.max(red, Math.max(green, blue));
            int minimum = Math.min(red, Math.min(green, blue));
            int chroma = maximum - minimum;
            if (maximum < 45 || chroma < 30 || chroma * 100 < maximum * 18) continue;
            int bucket = ((red >>> 5) << 6) | ((green >>> 5) << 3) | (blue >>> 5);
            long weight = (long) alpha * (chroma + 32L);
            weights[bucket] += weight;
            reds[bucket] += weight * red;
            greens[bucket] += weight * green;
            blues[bucket] += weight * blue;
        }
        int best = -1;
        for (int index = 0; index < weights.length; index++) {
            if (best < 0 || weights[index] > weights[best]) best = index;
        }
        if (best < 0 || weights[best] == 0L) return fallback;
        int red = (int) (reds[best] / weights[best]);
        int green = (int) (greens[best] / weights[best]);
        int blue = (int) (blues[best] / weights[best]);
        return 0xff000000 | red << 16 | green << 8 | blue;
    }
}
