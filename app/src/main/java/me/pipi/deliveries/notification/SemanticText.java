package me.pipi.deliveries.notification;

import android.annotation.SuppressLint;
import android.app.Notification;
import android.os.Build;
import android.text.SpannableString;
import android.text.Spanned;
import android.util.Log;

import java.lang.reflect.Method;

/** Single compatibility boundary for Android 16 semantic text annotations. */
public final class SemanticText {
    @SuppressLint("InlinedApi")
    public static final int CAUTION = Notification.SEMANTIC_STYLE_CAUTION;

    private static final String TAG = "PipiSemanticText";
    private static volatile Method annotationFactory;
    private static volatile boolean lookupComplete;

    private SemanticText() {}

    public static CharSequence annotate(
            CharSequence value, int semantic, int start, int end) {
        CharSequence source = value == null ? "" : value;
        int length = source.length();
        if (Build.VERSION.SDK_INT < 37 || length == 0
                || semantic == Notification.SEMANTIC_STYLE_UNSPECIFIED) {
            return source;
        }
        int safeStart = Math.max(0, Math.min(start, length));
        int safeEnd = Math.max(safeStart, Math.min(end, length));
        if (safeStart == safeEnd) return source;
        Method factory = annotationFactory();
        if (factory == null) return source;
        try {
            Object annotation = factory.invoke(null, semantic);
            SpannableString styled = new SpannableString(source);
            styled.setSpan(annotation, safeStart, safeEnd, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
            return styled;
        } catch (Throwable error) {
            Log.w(TAG, "semantic annotation unavailable", error);
            return source;
        }
    }

    private static Method annotationFactory() {
        if (lookupComplete) return annotationFactory;
        synchronized (SemanticText.class) {
            if (lookupComplete) return annotationFactory;
            try {
                annotationFactory = Notification.class.getMethod(
                        "createSemanticStyleAnnotation", int.class);
            } catch (Throwable error) {
                Log.w(TAG, "semantic annotation factory unavailable", error);
            } finally {
                lookupComplete = true;
            }
            return annotationFactory;
        }
    }
}
