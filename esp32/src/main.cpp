#include <Arduino.h>
#include <WiFi.h>
#include <WebServer.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <Preferences.h>
#include <ArduinoJson.h>
#include <time.h>
#include <esp_crt_bundle.h>
#include "secrets.h"

// ESP32-WROOM-32 port of jonny5509/bot. Writes are deliberately never retried.
static WebServer server(80);
static Preferences prefs;
static bool syncBusy = false;
static bool autoSync = false;
static uint32_t lastAutoCheck = 0;
static const uint32_t AUTO_INTERVAL_MS = 600000UL;
static const int DEFAULT_MAX_ADDITION_SECONDS = 2592000;

struct Integration {
  bool enabled = false;
  String token;
  String timerId;
  String userId;
};
static Integration chasterCfg, chastifyCfg, emlaCfg;
static int maxAdditionSeconds = DEFAULT_MAX_ADDITION_SECONDS;
static String lastStatus = "Ready";

struct Reading {
  String service;
  bool ok = false;
  String error;
  int64_t seconds = 0;
};
struct Change {
  String service;
  int64_t before = 0;
  int64_t add = 0;
  bool allowed = false;
  String status;
  String error;
};

static String jsonEscape(const String &s) {
  JsonDocument d; d["s"] = s; String out; serializeJson(d["s"], out); return out;
}
static String durationText(int64_t value) {
  uint64_t s = value < 0 ? 0 : (uint64_t)value;
  uint64_t d=s/86400, h=(s%86400)/3600, m=(s%3600)/60, sec=s%60;
  String out;
  if (d) out += String((unsigned long long)d) + "d ";
  if (h) out += String((unsigned long long)h) + "h ";
  if (m) out += String((unsigned long long)m) + "m ";
  out += String((unsigned long long)sec) + "s";
  out.trim(); return out;
}
static String encodeURIComponent(const String &input) {
  const char *hex = "0123456789ABCDEF"; String out;
  for (size_t i=0;i<input.length();i++) {
    uint8_t c=(uint8_t)input[i];
    if (isalnum(c) || c=='-' || c=='_' || c=='.' || c=='~') out += (char)c;
    else { out += '%'; out += hex[c>>4]; out += hex[c&15]; }
  }
  return out;
}
static bool authorized() {
  if (server.authenticate(DASHBOARD_USER, DASHBOARD_PASSWORD)) return true;
  server.requestAuthentication(BASIC_AUTH, "ESP32 Timer Sync", "Dashboard login required");
  return false;
}
static String requestApi(const String &service, const String &url, const String &method,
                         const String &token, const String &lockId, const String &body,
                         const String &emlaUser = "", const String &emlaKey = "") {
  WiFiClientSecure tls;
  tls.setCACertBundle(x509_crt_bundle_start); // Validate server certificates; never use setInsecure().
  HTTPClient http;
  http.setConnectTimeout(12000);
  http.setTimeout(15000);
  http.setFollowRedirects(HTTPC_DISABLE_FOLLOW_REDIRECTS);
  if (!http.begin(tls, url)) throw String(service + " HTTPS initialization failed.");
  http.addHeader("Accept", "application/json");
  if (service == "Chaster" || service == "Chastify") http.addHeader("Authorization", "Bearer " + token);
  if (service == "Chastify") http.addHeader("x-chastify-lock-id", lockId);
  if (method == "POST") http.addHeader("Content-Type", "application/json");
  int code;
  if (method == "POST") code = http.POST(body);
  else code = http.GET();
  String response = code > 0 ? http.getString() : "";
  http.end();
  if (code < 200 || code >= 300) {
    // Never include request URLs or credentials in errors (EmlaLock credentials are query parameters).
    throw String(service + " API request failed (HTTP " + String(code) + ").");
  }
  JsonDocument parsed;
  DeserializationError err = deserializeJson(parsed, response);
  if (err) throw String(service + " returned invalid JSON.");
  if (!parsed["error"].isNull() && parsed["error"].as<String>().length()) {
    String msg = parsed["message"] | parsed["error"].as<String>();
    if (msg.length() > 180) msg = msg.substring(0,180);
    throw String(service + " API error: " + msg);
  }
  return response;
}
static int64_t parseChasterEnd(JsonVariantConst value) {
  if (value.is<long long>() || value.is<unsigned long long>() || value.is<double>()) {
    double n=value.as<double>(); if (n>0 && n<1e12) n*=1000.0;
    if (n>0) return (int64_t)(n/1000.0);
  }
  if (!value.is<const char*>()) return 0;
  String s=value.as<String>();
  int y=0,mo=0,d=0,h=0,mi=0,se=0;
  if (sscanf(s.c_str(), "%d-%d-%dT%d:%d:%d", &y,&mo,&d,&h,&mi,&se) < 6) return 0;
  struct tm t={}; t.tm_year=y-1900; t.tm_mon=mo-1; t.tm_mday=d; t.tm_hour=h; t.tm_min=mi; t.tm_sec=se;
  // ISO-8601 timestamps from the provider are normally UTC. Offset suffixes are not interpreted here.
  time_t stamp = timegm(&t); return stamp > 0 ? (int64_t)stamp : 0;
}
static int64_t readChaster() {
  if (!chasterCfg.enabled || !chasterCfg.token.length() || !chasterCfg.timerId.length()) throw String("Chaster is not configured.");
  String raw=requestApi("Chaster","https://api.chaster.app/locks/"+encodeURIComponent(chasterCfg.timerId),"GET",chasterCfg.token,"","","","");
  JsonDocument d; deserializeJson(d,raw);
  JsonVariantConst lock=d["lock"].is<JsonObjectConst>()?d["lock"]:d["data"].is<JsonObjectConst>()?d["data"]:d.as<JsonVariantConst>();
  int64_t end=0;
  for (const char* key : {"endDate","endDateTime"}) { end=parseChasterEnd(lock[key]); if(end) break; }
  if(!end && lock["timer"].is<JsonObjectConst>()) end=parseChasterEnd(lock["timer"]["endDate"]);
  if(!end && lock["session"].is<JsonObjectConst>()) end=parseChasterEnd(lock["session"]["endDate"]);
  if(!end) throw String("Chaster response has no recognized end date.");
  return max((int64_t)0, end-(int64_t)time(nullptr));
}
static int64_t readChastify() {
  if (!chastifyCfg.enabled || !chastifyCfg.token.length() || chastifyCfg.timerId.length()!=24) throw String("Chastify needs an enabled integration, API key, and exact 24-character lock._id.");
  for(size_t i=0;i<chastifyCfg.timerId.length();i++) if(!isxdigit(chastifyCfg.timerId[i])) throw String("Chastify lock._id must be 24 hexadecimal characters.");
  String raw=requestApi("Chastify","https://chastify.net/api/apps/v1/session","GET",chastifyCfg.token,chastifyCfg.timerId,"");
  JsonDocument d; deserializeJson(d,raw);
  String returned=d["lock"]["_id"] | "";
  if(!returned.equalsIgnoreCase(chastifyCfg.timerId)) throw String("Chastify response lock ID does not match configured lock.");
  if(d["lockData"]["timeRemainingSeconds"].isNull()) throw String("Chastify did not return remaining time.");
  int64_t n=d["lockData"]["timeRemainingSeconds"].as<int64_t>();
  if(n<0) throw String("Chastify returned invalid remaining time.");
  return n;
}
static String emlaUrl(const String &path) {
  return "https://api.emlalock.com"+path+"?userid="+encodeURIComponent(emlaCfg.userId)+"&apikey="+encodeURIComponent(emlaCfg.token);
}
static int64_t readEmla() {
  if(!emlaCfg.enabled || !emlaCfg.token.length() || !emlaCfg.userId.length()) throw String("EmlaLock is not configured.");
  String raw=requestApi("EmlaLock",emlaUrl("/info"),"GET","","","","","");
  JsonDocument d; deserializeJson(d,raw);
  if(d["chastitysession"]["enddate"].isNull()) throw String("EmlaLock returned no active-session end date.");
  int64_t end=d["chastitysession"]["enddate"].as<int64_t>();
  if(end<=0) throw String("EmlaLock returned invalid end date.");
  return max((int64_t)0,end-(int64_t)time(nullptr));
}
static void addChaster(int64_t seconds) {
  if(seconds<=0 || seconds>INT32_MAX) throw String("Invalid Chaster addition.");
  String body="{\"duration\":"+String((long)seconds)+"}";
  requestApi("Chaster","https://api.chaster.app/locks/"+encodeURIComponent(chasterCfg.timerId)+"/update-time","POST",chasterCfg.token,"",body);
}
static void addChastify(int64_t seconds) {
  if(seconds<=0 || seconds>INT32_MAX) throw String("Invalid Chastify addition.");
  String body="{\"deltaSeconds\":"+String((long)seconds)+"}";
  requestApi("Chastify","https://chastify.net/api/apps/v1/lock/apply-time","POST",chastifyCfg.token,chastifyCfg.timerId,body);
}
static void addEmla(int64_t seconds) {
  if(seconds<=0 || seconds>INT32_MAX) throw String("Invalid EmlaLock addition.");
  String url=emlaUrl("/add")+"&value="+String((long)seconds);
  requestApi("EmlaLock",url,"GET","","","","","");
}
static Reading readOne(const String &name) {
  Reading r; r.service=name;
  try {
    if(name=="chaster") r.seconds=readChaster();
    else if(name=="chastify") r.seconds=readChastify();
    else r.seconds=readEmla();
    r.ok=true;
  } catch(String e) { r.error=e; }
    catch(...) { r.error="Unexpected provider error."; }
  if(r.ok && r.seconds<0) { r.ok=false; r.error="Provider returned invalid remaining time."; }
  return r;
}
static String readingsJson(const Reading r[3]) {
  String out="[";
  for(int i=0;i<3;i++) {
    if(i) out+=",";
    out+="{\"service\":"+jsonEscape(r[i].service)+",\"ok\":"+(r[i].ok?"true":"false");
    if(r[i].ok) out+=",\"seconds\":"+String((long long)r[i].seconds)+",\"remaining\":"+jsonEscape(durationText(r[i].seconds));
    else out+=",\"error\":"+jsonEscape(r[i].error);
    out+="}";
  }
  return out+"]";
}
static void readAll(Reading r[3]) {
  r[0]=readOne("chaster"); r[1]=readOne("chastify"); r[2]=readOne("emlalock");
}
static String previewJson(bool &ready, Reading r[3], Change c[3], int64_t &target) {
  readAll(r);
  bool configured=chasterCfg.enabled&&chasterCfg.token.length()&&chasterCfg.timerId.length()
    &&chastifyCfg.enabled&&chastifyCfg.token.length()&&chastifyCfg.timerId.length()==24
    &&emlaCfg.enabled&&emlaCfg.token.length()&&emlaCfg.userId.length();
  bool readable=r[0].ok&&r[1].ok&&r[2].ok;
  ready=configured&&readable;
  target=0;
  if(readable) target=max(r[0].seconds,max(r[1].seconds,r[2].seconds));
  for(int i=0;i<3;i++) {
    c[i].service=r[i].service; c[i].before=r[i].seconds;
    c[i].add=readable?target-r[i].seconds:0;
    c[i].allowed=c[i].add<=maxAdditionSeconds;
    c[i].status="preview";
  }
  String out="{\"ok\":"+(ready?String("true"):String("false"))+",\"writable\":"+(ready?String("true"):String("false"));
  out+=",\"targetSeconds\":"+String((long long)target)+",\"target\":"+jsonEscape(durationText(target));
  out+=",\"readings\":"+readingsJson(r)+",\"changes\":[";
  for(int i=0;i<3;i++) {
    if(i) out+=",";
    out+="{\"service\":"+jsonEscape(c[i].service)+",\"beforeSeconds\":"+String((long long)c[i].before);
    out+=",\"before\":"+jsonEscape(durationText(c[i].before))+",\"addSeconds\":"+String((long long)c[i].add);
    out+=",\"add\":"+jsonEscape(durationText(c[i].add))+",\"target\":"+jsonEscape(durationText(target));
    out+=",\"allowed\":"+(c[i].allowed?"true":"false")+"}";
  }
  out+="]";
  if(!configured || !readable) out+=",\"message\":\"All three integrations must be configured and readable. No changes will be sent.\"";
  else out+=",\"message\":\"Preview only until you explicitly start synchronization.\"";
  out+="}";
  return out;
}
static String runSyncJson() {
  if(syncBusy) return "{\"ok\":false,\"message\":\"A synchronization is already in progress.\"}";
  syncBusy=true;
  String result;
  Reading r[3]; Change c[3]; bool ready=false; int64_t target=0;
  try {
    previewJson(ready,r,c,target);
    if(!ready) {
      result="{\"ok\":false,\"message\":\"Comparison unavailable. No timer changes were sent.\",\"readings\":"+readingsJson(r)+",\"changes\":[]}";
    } else {
      bool tooLarge=false;
      for(int i=0;i<3;i++) if(c[i].add>0 && c[i].add>maxAdditionSeconds) tooLarge=true;
      if(tooLarge) {
        result="{\"ok\":false,\"message\":\"Sync blocked by the maximum-addition safety limit. No timer changes were sent.\",\"readings\":"+readingsJson(r)+",\"changes\":[";
        for(int i=0;i<3;i++) { if(i)result+=","; result+="{\"service\":"+jsonEscape(c[i].service)+",\"before\":"+jsonEscape(durationText(c[i].before))+",\"add\":"+jsonEscape(durationText(c[i].add))+",\"status\":\"blocked-limit\"}"; }
        result+="]}";
      } else {
        String changes="[";
        bool anyFailure=false;
        for(int i=0;i<3;i++) {
          if(i) changes+=",";
          String status="already-matched", error="";
          if(c[i].add>0) {
            try {
              // No retry: these endpoints may apply a time delta even if the response is lost.
              if(c[i].service=="chaster") addChaster(c[i].add);
              else if(c[i].service=="chastify") addChastify(c[i].add);
              else addEmla(c[i].add);
              status="changed";
            } catch(String e) { status="failed"; error=e; anyFailure=true; }
              catch(...) { status="failed"; error="Unexpected provider error."; anyFailure=true; }
          }
          changes+="{\"service\":"+jsonEscape(c[i].service)+",\"before\":"+jsonEscape(durationText(c[i].before));
          changes+=",\"add\":"+jsonEscape(durationText(c[i].add))+",\"status\":"+jsonEscape(status);
          if(error.length()) changes+=",\"error\":"+jsonEscape(error);
          changes+="}";
        }
        changes+="]";
        result="{\"ok\":"+String(anyFailure?"false":"true")+",\"target\":"+jsonEscape(durationText(target))+",\"readings\":"+readingsJson(r)+",\"changes\":"+changes;
        result+=",\"message\":"+jsonEscape(anyFailure?"One or more writes failed. Some timers may already have changed; verify every provider before retrying.":"Synchronization requests completed. Verify provider timers to confirm resulting values.")+"}";
      }
    }
  } catch(String e) { result="{\"ok\":false,\"message\":"+jsonEscape(e)+"}"; }
    catch(...) { result="{\"ok\":false,\"message\":\"Unexpected synchronization error.\"}"; }
  syncBusy=false;
  lastStatus=result;
  return result;
}

static const char INDEX_HTML[] PROGMEM = R"HTML(
<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ESP32 Timer Sync</title>
<style>
:root{color-scheme:dark;font:16px system-ui;background:#10151d;color:#e8edf4}body{max-width:920px;margin:auto;padding:20px}h1{font-size:1.8rem}h2{margin-top:0}section{background:#1b2430;border:1px solid #344154;border-radius:12px;padding:18px;margin:14px 0}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:12px}.svc{border:1px solid #3a485c;border-radius:10px;padding:14px}label{display:block;margin:9px 0 4px;color:#bdc9d8}input{box-sizing:border-box;width:100%;padding:10px;border-radius:7px;border:1px solid #516078;background:#101720;color:#fff}button{padding:11px 15px;border:0;border-radius:8px;background:#7db5ff;color:#10151d;font-weight:700;margin:5px 6px 5px 0;cursor:pointer}button.danger{background:#ffbf8b}button:disabled{opacity:.5}small,.muted{color:#b4c0d0}.warn{color:#ffd0a8}.good{color:#a9f1bd}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#101720;padding:12px;border-radius:8px}#msg{white-space:pre-wrap}</style></head><body>
<h1>ESP32 Timer Sync</h1><p class="muted">Standalone dashboard · Chaster / Chastify / EmlaLock</p>
<section><h2>Timer comparison</h2><p id="msg">Load a preview before syncing. A preview never changes timers.</p><div id="timers" class="grid"></div><button id="preview">Refresh preview</button><button id="sync" class="danger">Synchronize now</button><label><input id="auto" type="checkbox" style="width:auto"> Automatic checks every 10 minutes</label><p class="muted">Automatic mode starts OFF after reboot. A failed provider write can leave timers partially synchronized; verify provider values before retrying.</p><pre id="result"></pre></section>
<section><h2>Settings</h2><p class="muted">Blank API key fields preserve stored keys. Keys are never sent back to the browser. Protect this dashboard with its Basic Auth password and keep it on a trusted LAN.</p>
<form id="settings"><div class="grid">
<div class="svc"><h3>Wi-Fi / device</h3><p class="muted">Wi-Fi credentials are set in secrets.h before flashing.</p><label>Maximum addition (seconds)</label><input id="max" type="number" min="1" max="2592000" required></div>
<div class="svc"><h3>Chaster</h3><label><input id="chasterEnabled" type="checkbox" style="width:auto"> Enabled</label><label>Bearer token</label><input id="chasterToken" type="password" autocomplete="new-password"><label>Lock ID</label><input id="chasterId" autocomplete="off"></div>
<div class="svc"><h3>Chastify</h3><label><input id="chastifyEnabled" type="checkbox" style="width:auto"> Enabled</label><label>Developer API key</label><input id="chastifyToken" type="password" autocomplete="new-password"><label>Lock._id (24 hex chars)</label><input id="chastifyId" autocomplete="off" maxlength="24"></div>
<div class="svc"><h3>EmlaLock</h3><label><input id="emlaEnabled" type="checkbox" style="width:auto"> Enabled</label><label>API key</label><input id="emlaToken" type="password" autocomplete="new-password"><label>User ID</label><input id="emlaId" autocomplete="off"></div>
</div><button type="submit">Save settings</button></form></section>
<script>
const $=id=>document.getElementById(id);
async function api(path,method='GET',body){const r=await fetch(path,{method,headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});const t=await r.text();let d;try{d=JSON.parse(t)}catch{throw Error('Invalid server response ('+r.status+')')}if(!r.ok)throw Error(d.message||'HTTP '+r.status);return d}
function show(d){$('result').textContent=JSON.stringify(d,null,2);$('msg').textContent=d.message||'Complete';$('msg').className=d.ok?'good':'warn';$('timers').innerHTML='';(d.readings||[]).forEach(x=>{let el=document.createElement('div');el.className='svc';el.textContent=x.service+': '+(x.ok?x.remaining:'ERROR — '+x.error);$('timers').appendChild(el)});if(d.changes)(d.changes).forEach(x=>{let el=document.createElement('div');el.className='svc';el.textContent=x.service+': '+(x.before||'')+' → add '+(x.add||'')+' ('+(x.status|| (x.allowed?'within limit':'over limit'))+')';$('timers').appendChild(el)})}
async function preview(){ $('preview').disabled=true;try{show(await api('/api/preview'))}catch(e){$('msg').textContent=e.message}finally{$('preview').disabled=false}}
$('preview').onclick=preview;
$('sync').onclick=async()=>{if(!confirm('Send time-change requests to all three providers? Review the preview first.'))return;$('sync').disabled=true;try{show(await api('/api/sync','POST',{}))}catch(e){$('msg').textContent=e.message}finally{$('sync').disabled=false}};
$('auto').onchange=async()=>{try{await api('/api/auto','POST',{enabled:$('auto').checked})}catch(e){$('msg').textContent=e.message;$('auto').checked=false}};
$('settings').onsubmit=async e=>{e.preventDefault();const data={maxAdditionSeconds:Number($('max').value),integrations:{}};for(const n of ['chaster','chastify','emla']){const prefix=n==='emla'?'emla':n;data.integrations[n]={enabled:$(prefix+'Enabled').checked,apiToken:$(prefix+'Token').value,timerId:n==='emla'?'':$(prefix+'Id').value,userId:n==='emla'?$(prefix+'Id').value:''}}try{const d=await api('/api/settings','POST',data);$('msg').textContent=d.message;['chasterToken','chastifyToken','emlaToken'].forEach(id=>$(id).value='')}catch(err){$('msg').textContent=err.message}};
async function loadSettings(){try{const d=await api('/api/settings');$('max').value=d.maxAdditionSeconds;for(const n of ['chaster','chastify','emlalock']){const p=n==='emlalock'?'emla':n;$(p+'Enabled').checked=d.integrations[n].enabled;$(p+'Id').value=n==='emlalock'?d.integrations[n].userId:d.integrations[n].timerId}}catch(e){$('msg').textContent=e.message}}
loadSettings();preview();setInterval(async()=>{try{const d=await api('/api/auto');$('auto').checked=d.enabled}catch{}},15000);
</script></body></html>
)HTML";

static void sendJson(int code, const String &body) { server.send(code,"application/json; charset=utf-8",body); }
static void handleRoot() { if(!authorized()) return; server.send_P(200,"text/html; charset=utf-8",INDEX_HTML); }
static void handleGetSettings() {
  if(!authorized()) return;
  String out="{\"maxAdditionSeconds\":"+String(maxAdditionSeconds)+",\"integrations\":{";
  out+="\"chaster\":{\"enabled\":"+(chasterCfg.enabled?String("true"):String("false"))+",\"timerId\":"+jsonEscape(chasterCfg.timerId)+"},";
  out+="\"chastify\":{\"enabled\":"+(chastifyCfg.enabled?String("true"):String("false"))+",\"timerId\":"+jsonEscape(chastifyCfg.timerId)+"},";
  out+="\"emlalock\":{\"enabled\":"+(emlaCfg.enabled?String("true"):String("false"))+",\"userId\":"+jsonEscape(emlaCfg.userId)+"}}}";
  sendJson(200,out);
}
static void handleSaveSettings() {
  if(!authorized()) return;
  JsonDocument d; if(deserializeJson(d,server.arg("plain"))) { sendJson(400,"{\"message\":\"Invalid JSON.\"}"); return; }
  int limit=d["maxAdditionSeconds"]|DEFAULT_MAX_ADDITION_SECONDS;
  if(limit<1 || limit>DEFAULT_MAX_ADDITION_SECONDS) { sendJson(400,"{\"message\":\"Maximum addition must be between 1 and 2592000 seconds (30 days).\"}"); return; }
  JsonObject integrations=d["integrations"];
  if(integrations.isNull()) { sendJson(400,"{\"message\":\"Missing integrations.\"}"); return; }
  auto update=[&](const char* key, Integration &cfg) {
    JsonObject item=integrations[key];
    if(item.isNull()) return;
    cfg.enabled=item["enabled"]|false;
    String token=item["apiToken"]|"";
    if(token.length()) cfg.token=token; // empty form field preserves existing secret
    if(String(key)=="emlalock") cfg.userId=String((const char*)(item["userId"]|""));
    else { cfg.timerId=String((const char*)(item["timerId"]|"")); if(item["userId"].is<const char*>()) cfg.userId=String((const char*)item["userId"]); }
  };
  maxAdditionSeconds=limit;
  update("chaster",chasterCfg); update("chastify",chastifyCfg); update("emlalock",emlaCfg);
  prefs.putInt("maxAdd",maxAdditionSeconds);
  auto save=[&](const char* key, const Integration &cfg) {
    String p=String(key)+"_";
    prefs.putBool((p+"on").c_str(),cfg.enabled);
    prefs.putString((p+"token").c_str(),cfg.token);
    prefs.putString((p+"id").c_str(),cfg.timerId);
    prefs.putString((p+"user").c_str(),cfg.userId);
  };
  save("chaster",chasterCfg); save("chastify",chastifyCfg); save("emla",emlaCfg);
  sendJson(200,"{\"ok\":true,\"message\":\"Settings saved to ESP32 non-volatile storage.\"}");
}
static void handlePreview() {
  if(!authorized()) return;
  Reading r[3]; Change c[3]; bool ready=false; int64_t target=0;
  String out=previewJson(ready,r,c,target); sendJson(200,out);
}
static void handleSync() {
  if(!authorized()) return;
  if(syncBusy) { sendJson(409,"{\"ok\":false,\"message\":\"A synchronization is already in progress.\"}"); return; }
  sendJson(200,runSyncJson());
}
static void handleAutoGet() { if(!authorized()) return; sendJson(200,String("{\"enabled\":")+(autoSync?"true":"false")+"}"); }
static void handleAutoSet() {
  if(!authorized()) return;
  JsonDocument d; if(deserializeJson(d,server.arg("plain"))) { sendJson(400,"{\"message\":\"Invalid JSON.\"}"); return; }
  autoSync=d["enabled"]|false; lastAutoCheck=millis();
  sendJson(200,String("{\"ok\":true,\"enabled\":")+(autoSync?"true":"false")+"}");
}
static void loadSaved() {
  prefs.begin("timersync",false);
  maxAdditionSeconds=prefs.getInt("maxAdd",DEFAULT_MAX_ADDITION_SECONDS);
  auto load=[&](const char* key, Integration &cfg) {
    String p=String(key)+"_";
    cfg.enabled=prefs.getBool((p+"on").c_str(),false);
    cfg.token=prefs.getString((p+"token").c_str(),"");
    cfg.timerId=prefs.getString((p+"id").c_str(),"");
    cfg.userId=prefs.getString((p+"user").c_str(),"");
  };
  load("chaster",chasterCfg); load("chastify",chastifyCfg); load("emla",emlaCfg);
}
static void setupRoutes() {
  server.on("/",HTTP_GET,handleRoot);
  server.on("/api/settings",HTTP_GET,handleGetSettings);
  server.on("/api/settings",HTTP_POST,handleSaveSettings);
  server.on("/api/preview",HTTP_GET,handlePreview);
  server.on("/api/sync",HTTP_POST,handleSync);
  server.on("/api/auto",HTTP_GET,handleAutoGet);
  server.on("/api/auto",HTTP_POST,handleAutoSet);
  server.onNotFound([](){ if(!authorized())return; sendJson(404,"{\"message\":\"Not found.\"}"); });
}
void setup() {
  Serial.begin(115200); delay(250);
  if(String(DASHBOARD_PASSWORD).length()<16) { Serial.println("FATAL: Set a unique dashboard password of at least 16 characters in secrets.h."); while(true) delay(1000); }
  loadSaved();
  WiFi.mode(WIFI_STA);
  WiFi.setHostname("timer-sync-esp32");
  WiFi.begin(WIFI_SSID,WIFI_PASSWORD);
  Serial.print("Connecting to Wi-Fi");
  uint32_t start=millis();
  while(WiFi.status()!=WL_CONNECTED && millis()-start<30000) { delay(500); Serial.print("."); }
  if(WiFi.status()!=WL_CONNECTED) {
    Serial.println("\nWi-Fi connection failed. Check WIFI_SSID and WIFI_PASSWORD in secrets.h; reboot to retry.");
    while(true) delay(1000);
  }
  configTime(0,0,"pool.ntp.org","time.nist.gov");
  Serial.printf("\nDashboard: http://%s/\n",WiFi.localIP().toString().c_str());
  Serial.println("Use the dashboard credentials from secrets.h. Keep the device on a trusted LAN.");
  setupRoutes(); server.begin();
}
void loop() {
  server.handleClient();
  if(autoSync && !syncBusy && WiFi.status()==WL_CONNECTED && millis()-lastAutoCheck>=AUTO_INTERVAL_MS) {
    lastAutoCheck=millis();
    // Skip if the system clock is not synchronized; TLS validation also depends on correct time.
    if(time(nullptr)>1700000000) { Serial.println("Automatic timer comparison starting."); String result=runSyncJson(); Serial.println(result); }
    else Serial.println("Automatic sync skipped: clock is not synchronized.");
  }
  delay(2);
}
