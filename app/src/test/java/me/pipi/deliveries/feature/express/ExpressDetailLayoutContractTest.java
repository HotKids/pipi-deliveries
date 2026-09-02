package me.pipi.deliveries.feature.express;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import android.app.Application;
import android.view.View;

import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35, manifest = Config.NONE, application = Application.class)
public final class ExpressDetailLayoutContractTest {
    @Test
    public void carrierWaybillAndCopyIconStayInOneTightInlineControl() throws Exception {
        String layout = projectFile("app/src/main/res/layout/activity_express_detail.xml");
        String waybill = element(layout, "@+id/detail_waybill");
        String source = projectFile(
                "app/src/main/java/me/pipi/deliveries/feature/express/ExpressDetailActivity.java");
        String strings = projectFile(
                "app/src/main/res/values/express_detail_strings.xml");

        assertTrue(waybill.contains("android:drawableEnd=\"@drawable/ic_copy\""));
        assertTrue(waybill.contains("android:drawablePadding=\"6dp\""));
        assertTrue(waybill.contains("android:layout_width=\"wrap_content\""));
        assertFalse(waybill.contains("android:layout_width=\"match_parent\""));
        assertTrue(waybill.contains("android:maxLines=\"1\""));
        assertTrue(waybill.contains("android:autoSizeTextType=\"uniform\""));
        assertTrue(waybill.contains("android:autoSizeMinTextSize=\"10sp\""));
        assertTrue(waybill.contains("android:autoSizeMaxTextSize=\"15sp\""));
        assertFalse(waybill.contains("android:ellipsize="));
        assertFalse(waybill.contains("android:layout_weight="));
        assertFalse(layout.contains("@+id/detail_waybill_copy"));
        assertTrue(source.contains("waybillView.setOnClickListener"));
        assertTrue(source.contains("ClipData.newPlainText"));
        assertTrue(source.contains("ClipboardManager.class"));
        assertTrue(strings.contains(
                "<string name=\"copy_waybill\">复制运单号</string>"));
        assertTrue(strings.contains(
                "<string name=\"waybill_copied\">运单号已复制</string>"));
    }

    @Test
    public void webAndNativeRootsApplySystemBarInsetsExactlyOnce() throws Exception {
        String web = projectFile("app/src/main/res/layout/activity_express_web.xml");
        String detail = projectFile("app/src/main/res/layout/activity_express_detail.xml");
        assertTrue(web.contains("android:id=\"@+id/express_web_root\""));
        assertTrue(detail.contains("android:id=\"@+id/express_detail_root\""));
        assertFalse(web.contains("android:fitsSystemWindows="));
        assertFalse(detail.contains("android:fitsSystemWindows="));

        View root = new View(RuntimeEnvironment.getApplication());
        root.setPadding(5, 7, 11, 13);
        ExpressDetailActivity.applySystemBarInsets(root);
        WindowInsetsCompat insets = new WindowInsetsCompat.Builder()
                .setInsets(WindowInsetsCompat.Type.systemBars(), Insets.of(2, 3, 4, 6))
                .build();
        ViewCompat.dispatchApplyWindowInsets(root, insets);
        assertEquals(7, root.getPaddingLeft());
        assertEquals(10, root.getPaddingTop());
        assertEquals(15, root.getPaddingRight());
        assertEquals(19, root.getPaddingBottom());
        ViewCompat.dispatchApplyWindowInsets(root, insets);
        assertEquals(10, root.getPaddingTop());
        assertEquals(19, root.getPaddingBottom());
    }

    private static String element(String layout, String id) {
        int idOffset = layout.indexOf(id);
        int start = layout.lastIndexOf('<', idOffset);
        int end = layout.indexOf("/>", idOffset);
        assertTrue(start >= 0 && end > idOffset);
        return layout.substring(start, end + 2);
    }

    private static String projectFile(String relative) throws Exception {
        Path path = Path.of(relative);
        if (!Files.isRegularFile(path) && relative.startsWith("app/")) {
            path = Path.of(relative.substring("app/".length()));
        }
        return Files.readString(path, StandardCharsets.UTF_8);
    }
}
