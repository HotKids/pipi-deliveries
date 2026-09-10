package me.pipi.deliveries.network;
import me.pipi.deliveries.data.*;
import android.app.Application;
import android.content.Context;
import me.pipi.deliveries.model.*;
import me.pipi.deliveries.network.ExpressDiscoveryClient;
import org.json.*;
import org.junit.*;
import org.junit.runner.RunWith;
import org.robolectric.*;
import org.robolectric.annotation.*;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk=31, manifest=Config.NONE, application=Application.class)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public class AutomaticFeedPersistenceTest {
 private Context context; private ExpressDatabase database; private ExpressRepository repository;
 private static final String PHONE="13900000001";
 @Before public void setup() throws Exception {
  context=RuntimeEnvironment.getApplication(); context.deleteDatabase(ExpressDatabase.DATABASE);
  context.getSharedPreferences("deliveries_repository_migrations",0).edit().clear().commit();
  database=new ExpressDatabase(context);
  var constructor=ExpressRepository.class.getDeclaredConstructor(Context.class,ExpressDatabase.class);
  constructor.setAccessible(true);
  repository=constructor.newInstance(context,database);
  repository.bindPhoneLocally(PHONE,"interface5");
 }
 @After public void close(){database.close();context.deleteDatabase(ExpressDatabase.DATABASE);}
 private ExpressQueryResult parse(boolean jd) throws Exception {
  JSONObject feed=new JSONObject().put("mailNo",jd?"1234567890123456":"ZTO_SYNTHETIC_01")
   .put("cpCode",jd?"JDKD":"ZTO").put("name",jd?"京东物流":"中通快递")
   .put("provider",jd?"JingDong":"CaiNiao").put("phone",PHONE).put("stateNum",104)
   .put("details",new JSONArray().put(new JSONObject().put("time","2026-09-09 18:00:00").put("desc","运输中")));
  return jd ? ExpressDiscoveryClient.parseAccountOrder(feed) : ExpressDiscoveryClient.parseExpress(feed,"",PHONE);
 }
 @Test public void cainiaoParserToDatabase() throws Exception {
  ExpressQueryResult r=parse(false);
  assertNotNull(r); assertEquals(StatusSemantic.TRANSIT,r.semantic); assertTrue(r.carrierIdentityEvidence);
  repository.saveInterface5(r,PHONE);
  boolean inserted=repository.findByWaybill(r.waybill,"interface5")!=null;
  assertTrue("Current parser result must establish its source owner",inserted);
 }
 @Test public void jingdongParserToProjectionClaim() throws Exception {
  ExpressQueryResult r=parse(true); assertNotNull(r);
  repository.saveInterface5OrderSummary(r,PHONE);
  ExpressItem row=repository.findByWaybill(r.waybill,"interface5"); assertNotNull(row);
  boolean claim=repository.captureManualQueryOwner(row)!=null;
  assertTrue("Current parser result must permit the existing projection path",claim);
 }

 @Test public void emptyCainiaoFeedDisplaysItsOwnQueryActivityWithoutChangingFeed() throws Exception {
  JSONObject raw=new JSONObject().put("mailNo","ZTO_SYNTHETIC_01").put("cpCode","ZTO")
   .put("name","中通快递").put("provider","CaiNiao").put("phone",PHONE).put("stateNum",104)
   .put("details",new JSONArray().put(new JSONObject().put("time","2026-09-09 18:00:00")
    .put("desc","快递状态已更新，点击查看>>")));
  ExpressQueryResult feed=ExpressDiscoveryClient.parseExpress(raw,"",PHONE);
  repository.saveInterface5(feed,PHONE);
  ExpressItem owner=repository.findByWaybill(feed.waybill,"interface5");
  raw.put("stateNum",105).put("details",new JSONArray().put(new JSONObject()
   .put("time","2026-09-09 18:10:00").put("desc","快件已到达深圳转运中心")));
  ExpressQueryResult query=ExpressDiscoveryClient.parseExpress(raw,"",PHONE);
  assertTrue(repository.saveInterface5Query(query,owner,repository.bindingGeneration(PHONE,"interface5")));
  ExpressItem visible=repository.listVisible("interface5").get(0);
  assertEquals("A real same-owner query event must fill the empty Home activity",query.latestDetail,visible.latestDetail);
  assertEquals(query.latestTime,visible.latestTime);
  assertEquals(StatusSemantic.TRANSIT,visible.semantic);
  assertEquals(feed.statusEventTime,visible.statusEventTime);
  assertEquals("[]",repository.automaticSourceTimeline(visible).tracksJson);
  assertEquals(query.latestDetail,repository.find(owner.rowId).latestDetail);
 }

 @Test public void existingFeedActivityStillOwnsHomeWhenQueryIsNewer() throws Exception {
  ExpressQueryResult feed=parse(false);
  repository.saveInterface5(feed,PHONE);
  ExpressItem owner=repository.findByWaybill(feed.waybill,"interface5");
  JSONObject raw=new JSONObject().put("mailNo",feed.waybill).put("cpCode","ZTO")
   .put("name","中通快递").put("provider","CaiNiao").put("phone",PHONE).put("stateNum",105)
   .put("details",new JSONArray().put(new JSONObject().put("time","2026-09-09 18:10:00")
    .put("desc","快件已到达深圳转运中心")));
  assertTrue(repository.saveInterface5Query(ExpressDiscoveryClient.parseExpress(raw,"",PHONE),
   owner,repository.bindingGeneration(PHONE,"interface5")));
  ExpressItem visible=repository.listVisible("interface5").get(0);
  assertEquals(feed.latestDetail,visible.latestDetail);
  assertEquals(feed.latestTime,visible.latestTime);
  assertEquals(feed.semantic,visible.semantic);
 }

 @Test public void interface6ParserToDatabase() throws Exception {
  repository.bindPhoneLocally(PHONE,"interface6");
  JSONObject feed=new JSONObject().put("mailNo","ZTO_SYNTHETIC_06").put("cpCode","ZTO")
   .put("cpName","中通快递").put("provider","CaiNiao").put("subPhone",PHONE)
   .put("logsiticsStatus","1").put("logisticsStatusDesc","运输中")
   .put("lastLogisticDetail","运输中").put("logisticsGmtModified","2026-09-09 18:00:00");
  ExpressQueryResult r=ExpressSubscriptionClient.parseExpress(feed,"","");
  assertNotNull(r); assertTrue(r.carrierIdentityEvidence); assertNotEquals(StatusSemantic.UNKNOWN,r.semantic);
  repository.saveInterface6(r,PHONE);
  boolean inserted=repository.findByWaybill(r.waybill,"interface6")!=null;
  assertTrue("Current interface6 parser result must establish its source owner",inserted);
 }
}
