package me.pipi.deliveries.feature.express;
import android.app.Application;
import android.view.View;
import android.widget.TextView;
import me.pipi.deliveries.model.StatusSemantic;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;
@RunWith(RobolectricTestRunner.class)
@Config(sdk=31,manifest=Config.NONE,application=Application.class)
public class ExpressSenderBadgeTest {
 // Owner 2026-11-27 (修改 24, Material): the light text colour at 0x1A under the appearance's text colour, unadjusted.
 @Test public void rebindingAReceiverHidesTheExistingSenderBadge() {
  BadgeView view=new BadgeView();
  ExpressSenderBadge.apply(view,true,StatusSemantic.DELIVERY,"派送中");
  assertEquals("寄",view.getText().toString()); assertEquals(View.VISIBLE,view.getVisibility());
  assertEquals(0xFF2E7D32,view.getCurrentTextColor());
  assertEquals(0x1a2e7d32,((android.graphics.drawable.GradientDrawable) view.getBackground()).getColor().getDefaultColor());
  assertFalse(view.getIncludeFontPadding()); assertEquals(android.graphics.Typeface.BOLD,view.requestedStyle);
  ExpressSenderBadge.apply(view,false,StatusSemantic.DANGER,"异常件");
  assertEquals(View.GONE,view.getVisibility());
 }
 @Config(qualifiers="night")
 @Test public void nightBadgeKeepsTheLightFillUnderTheNightTextColour() {
  BadgeView view=new BadgeView();
  ExpressSenderBadge.apply(view,true,StatusSemantic.WAITING_PICKUP,"待取件");
  assertEquals(0xFFC5E1A5,view.getCurrentTextColor());
  assertEquals(0x1a558b2f,((android.graphics.drawable.GradientDrawable) view.getBackground()).getColor().getDefaultColor());
 }
 private static final class BadgeView extends TextView {
  int requestedStyle;
  BadgeView() { super(new android.view.ContextThemeWrapper(RuntimeEnvironment.getApplication(), com.google.android.material.R.style.Theme_Material3_DayNight)); }
  @Override public void setTypeface(android.graphics.Typeface typeface,int style) {
   requestedStyle=style;
   super.setTypeface(typeface,style);
  }
 }
}
