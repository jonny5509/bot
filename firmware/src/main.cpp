#include <Arduino.h>
#include <WiFi.h>
#include <WebServer.h>
#include <DNSServer.h>
#include <Preferences.h>
#include <LittleFS.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <time.h>

static const char *AP_NAME="TimerSync-Setup";
static const uint32_t INTERVAL_MS=600000, HTTP_TIMEOUT_MS=12000;
WebServer server(80); DNSServer dns; Preferences prefs;
String caPem,wifiSsid,wifiPassword,adminPin,ct,cl,ft,fl,eu,ek;
uint32_t maxAdd=2592000,lastAuto=0;
bool autoSync=false,busy=false;
String lastStatus="Not run yet",lastRunAt="";

struct Reading { const char *name; bool ok; int64_t seconds; String error; };
String esc(const String &s){String o;for(char c:s){if(c=='"'||c=='\\'){o+='\\';o+=c;}else if(c=='\n')o+="\\n";else if((uint8_t)c>=32)o+=c;}return o;}
String num64(int64_t n){char b[24];snprintf(b,sizeof(b),"%lld",(long long)n);return String(b);}\nString dur(int64_t n){if(n<0)n=0;String o;int64_t d=n/86400,h=n%86400/3600,m=n%3600/60,s=n%60;if(d)o+=num64(d)+"d ";if(h)o+=num64(h)+"h ";if(m)o+=num64(m)+"m ";o+=num64(s)+"s";o.trim();return o;}
String urlenc(const String &s){const char *hex="0123456789ABCDEF";String o;for(uint8_t c:s){if(isalnum(c)||c=='-'||c=='_'||c=='.'||c=='~')o+=(char)c;else{o+='%';o+=hex[c>>4];o+=hex[c&15];}}return o;}
bool parse(const String &s,JsonDocument &d){d.clear();return deserializeJson(d,s)==DeserializationError::Ok;}
bool requestJson(const String &url,const String &method,const String &token,const String &body,JsonDocument &out,String &err,const String &hn="",const String &hv=""){
 if(caPem.isEmpty()){err="TLS root CA bundle missing at /ca.pem.";return false;}
 WiFiClientSecure client;client.setCACert(caPem.c_str()); // Never disable certificate verification.
 HTTPClient http;http.setTimeout(HTTP_TIMEOUT_MS);
 if(!http.begin(client,url)){err="HTTPS request could not start.";return false;}
 http.addHeader("Accept","application/json");if(!token.isEmpty())http.addHeader("Authorization","Bearer "+token);
 if(!body.isEmpty())http.addHeader("Content-Type","application/json");if(!hn.isEmpty())http.addHeader(hn,hv);
 int code=method=="GET"?http.GET():http.POST(body);String response=code>0?http.getString():"";http.end();
 if(code<200||code>=300){err=(code==401||code==403)?"Authentication/permission rejected (HTTP "+String(code)+").":code<0?"Network/TLS error; outcome may be uncertain, request not retried.":"Provider HTTP error "+String(code)+".";return false;}
 if(response.isEmpty()){out.clear();return true;}if(!parse(response,out)){err="Provider returned invalid JSON.";return false;}if(!out["error"].isNull()){err="Provider returned an API error.";return false;}return true;
}
bool readChaster(int64_t &s,String &e){
 JsonDocument d;if(!requestJson("https://api.chaster.app/locks/"+urlenc(cl),"GET",ct,"",d,e))return false;
 JsonVariantConst l=d.as<JsonVariantConst>();if(d["lock"].is<JsonObjectConst>())l=d["lock"].as<JsonVariantConst>();else if(d["data"].is<JsonObjectConst>())l=d["data"].as<JsonVariantConst>();
 String dt=l["endDate"]|String("");if(dt.isEmpty())dt=l["endDateTime"]|String("");if(dt.isEmpty())dt=l["timer"]["endDate"]|String("");if(dt.isEmpty())dt=l["session"]["endDate"]|String("");
 int y,mo,day,h,mi,se;if(sscanf(dt.c_str(),"%4d-%2d-%2dT%2d:%2d:%2d",&y,&mo,&day,&h,&mi,&se)!=6){e="Chaster end date not recognized.";return false;}
 struct tm t={};t.tm_year=y-1900;t.tm_mon=mo-1;t.tm_mday=day;t.tm_hour=h;t.tm_min=mi;t.tm_sec=se;time_t end=timegm(&t);
 int p=dt.indexOf('+');if(p<0)p=dt.lastIndexOf('-');if(p>10&&p+5<=(int)dt.length()){int sign=dt[p]=='+'?1:-1;end-=sign*(dt.substring(p+1,p+3).toInt()*3600+dt.substring(p+4,p+6).toInt()*60);}
 time_t now=time(nullptr);if(now<100000){e="Clock not synchronized yet; wait for NTP.";return false;}s=max((int64_t)0,(int64_t)end-(int64_t)now);return true;
}
bool readChastify(int64_t &s,String &e){JsonDocument d;if(!requestJson("https://chastify.net/api/apps/v1/session","GET",ft,"",d,e,"x-chastify-lock-id",fl))return false;
 String id=d["lock"]["_id"]|String("");if(!id.equalsIgnoreCase(fl)||d["lockData"]["timeRemainingSeconds"].isNull()){e="Chastify lock/time response mismatch.";return false;}s=max((int64_t)0,d["lockData"]["timeRemainingSeconds"].as<long long>());return true;}
bool readEmla(int64_t &s,String &e){JsonDocument d;String u="https://api.emlalock.com/info?userid="+urlenc(eu)+"&apikey="+urlenc(ek);
 if(!requestJson(u,"GET","", "",d,e))return false;if(d["chastitysession"]["enddate"].isNull()){e="EmlaLock has no session end date.";return false;}
 int64_t end=d["chastitysession"]["enddate"].as<long long>();if(end>100000000000LL)end/=1000;time_t now=time(nullptr);if(now<100000||end<=0){e="Invalid clock or end date.";return false;}s=max((int64_t)0,end-(int64_t)now);return true;}
bool readSvc(int i,int64_t &s,String &e){return i==0?readChaster(s,e):i==1?readChastify(s,e):readEmla(s,e);}
bool addSvc(int i,int64_t s,String &e){if(s<=0||s>INT32_MAX){e="Addition outside supported range.";return false;}JsonDocument d;
 if(i==0)return requestJson("https://api.chaster.app/locks/"+urlenc(cl)+"/update-time","POST",ct,"{\"duration\":"+String((long)s)+"}",d,e);
 if(i==1)return requestJson("https://chastify.net/api/apps/v1/lock/apply-time","POST",ft,"{\"deltaSeconds\":"+String((long)s)+"}",d,e,"x-chastify-lock-id",fl);
 return requestJson("https://api.emlalock.com/add?userid="+urlenc(eu)+"&apikey="+urlenc(ek)+"&value="+String((long)s),"GET","", "",d,e);
}
bool auth(){String p=server.header("X-Admin-Pin");return adminPin.length()>=8&&p==adminPin;}
void sendJ(int code,const String &s){server.sendHeader("Cache-Control","no-store");server.sendHeader("X-Content-Type-Options","nosniff");server.send(code,"application/json",s);}
String stateJson(){return "{\"ok\":true,\"wifi\":"+String(WiFi.status()==WL_CONNECTED?"true":"false")+",\"ip\":\""+WiFi.localIP().toString()+"\",\"autoSync\":"+(autoSync?"true":"false")+",\"busy\":"+(busy?"true":"false")+",\"lastStatus\":\""+esc(lastStatus)+"\",\"lastRunAt\":\""+lastRunAt+"\"}";}
String html(){return R"HTML(<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Timer Sync</title><style>body{font:16px system-ui;max-width:760px;margin:24px auto;padding:0 14px;background:#f4f6f8;color:#18202a}section{background:white;border:1px solid #ddd;border-radius:12px;padding:16px;margin:12px 0}input,button{font:inherit;padding:10px;margin:4px 0;max-width:100%;box-sizing:border-box}input{width:100%}button{cursor:pointer;border:0;border-radius:8px;background:#172b4d;color:white}pre{white-space:pre-wrap;overflow-wrap:anywhere}.muted{color:#596575}</style></head><body><h1>Timer Sync</h1><p class="muted">ESP32 local dashboard. Credentials are never sent back to the browser.</p>
<section><h2>Timer preview</h2><button onclick="preview()">Refresh</button><pre id="p">Loading…</pre><button onclick="syncNow()">Sync now</button><button id="auto" onclick="toggleAuto()">Start automatic sync</button><pre id="s"></pre></section>
<section><h2>Settings</h2><p class="muted">PIN protects changes. Leave token fields blank to keep saved credentials.</p><form id="f">
<label>Current dashboard PIN (leave blank only on first setup)<input id="pin" type="password" autocomplete="current-password"></label><label>New dashboard PIN (8+ characters)<input id="newpin" type="password" minlength="8" required autocomplete="new-password"></label>
<label>Chaster lock ID<input id="cl"></label><label>New Chaster token<input id="ct" type="password" autocomplete="new-password"></label>
<label>Chastify lock ID (24 hex chars)<input id="fl"></label><label>New Chastify token<input id="ft" type="password" autocomplete="new-password"></label>
<label>EmlaLock user ID<input id="eu"></label><label>New EmlaLock API key<input id="ek" type="password" autocomplete="new-password"></label>
<label>Maximum addition (seconds)<input id="mx" type="number" min="0" max="31536000" value="2592000"></label><button>Save settings</button></form><pre id="r"></pre></section>
<script>const $=x=>document.getElementById(x);function h(){return {'Content-Type':'application/json','X-Admin-Pin':$('pin').value}}async function api(u,o={}){let r=await fetch(u,{...o,headers:{...h(),...(o.headers||{})}}),j=await r.json();if(!r.ok)throw Error(j.message||'Request failed');return j}async function preview(){try{$('p').textContent=JSON.stringify(await api('/api/preview'),null,2)}catch(e){$('p').textContent=e.message}}async function status(){try{let s=await(await fetch('/api/state')).json();$('s').textContent=JSON.stringify(s,null,2);$('auto').textContent=s.autoSync?'Stop automatic sync':'Start automatic sync'}catch(e){}}async function syncNow(){if(!confirm('Send time additions? Check preview first.'))return;try{$('p').textContent=JSON.stringify(await api('/api/sync',{method:'POST',body:'{}'}),null,2)}catch(e){$('p').textContent=e.message}status()}async function toggleAuto(){try{let s=await api('/api/auto',{method:'POST',body:JSON.stringify({enabled:!((await(await fetch('/api/state')).json()).autoSync)})});$('s').textContent=JSON.stringify(s,null,2);status()}catch(e){$('s').textContent=e.message}}$('f').onsubmit=async e=>{e.preventDefault();try{let d={pin:$('newpin').value,chasterLock:$('cl').value,chasterToken:$('ct').value,chastifyLock:$('fl').value,chastifyToken:$('ft').value,emlaUser:$('eu').value,emlaKey:$('ek').value,maxAdditionSeconds:Number($('mx').value)};let x=await api('/api/settings',{method:'POST',body:JSON.stringify(d)});$('r').textContent=x.message;$('pin').value=$('newpin').value;$('ct').value=$('ft').value=$('ek').value=''}catch(e){$('r').textContent=e.message}};preview();status();setInterval(()=>{preview();status()},30000)</script></body></html>)HTML";}
String runSyncCore(){
 if(busy)return "{\"ok\":false,\"message\":\"A sync is already running.\"}";
 busy=true;Reading r[3]={{"chaster",false,0,""},{"chastify",false,0,""},{"emlalock",false,0,""}};bool all=true;int64_t target=0;
 for(int i=0;i<3;i++){r[i].ok=readSvc(i,r[i].seconds,r[i].error);if(!r[i].ok)all=false;else target=max(target,r[i].seconds);}
 if(!all){busy=false;lastStatus="Preflight failed; no changes sent.";return "{\"ok\":false,\"message\":\"One or more timers could not be read; no changes sent. Check preview.\"}";}
 for(int i=0;i<3;i++)if(target-r[i].seconds>(int64_t)maxAdd){busy=false;lastStatus="Blocked by maximum-addition limit.";return "{\"ok\":false,\"message\":\"Safety limit exceeded; no changes sent.\"}";}
 // Never retry a non-idempotent request. Stop on the first failure.
 String failure="";bool ok=true;
 for(int i=0;i<3;i++){int64_t add=target-r[i].seconds;if(add==0)continue;String e;if(!addSvc(i,add,e)){ok=false;failure=String(r[i].name)+": "+e;break;}}
 if(ok){int64_t verified[3]={0,0,0};for(int i=0;i<3;i++){String e;if(!readSvc(i,verified[i],e)){ok=false;failure=String(r[i].name)+" write may have succeeded but verification failed; inspect all timers before retrying.";break;}}if(ok){int64_t lo=verified[0],hi=verified[0];for(int i=1;i<3;i++){lo=min(lo,verified[i]);hi=max(hi,verified[i]);}if(hi-lo>15){ok=false;failure="Verification readings differ by more than 15 seconds; inspect all timers before retrying.";}}}
 busy=false;lastRunAt=String((uint32_t)(millis()/1000))+"s since boot";lastStatus=ok?"Writes accepted and verification reads succeeded.":failure;
 return "{\"ok\":"+(ok?String("true"):String("false"))+",\"message\":\""+esc(lastStatus)+"\"}";
}
void load(){prefs.begin("timersync",true);wifiSsid=prefs.getString("ssid","");wifiPassword=prefs.getString("wpass","");adminPin=prefs.getString("pin","");
 cl=prefs.getString("cl","");ct=prefs.getString("ct","");fl=prefs.getString("fl","");ft=prefs.getString("ft","");eu=prefs.getString("eu","");ek=prefs.getString("ek","");maxAdd=prefs.getUInt("maxadd",2592000);prefs.end();}
void saveSettings(){
 if(adminPin.length() && !auth()){sendJ(401,"{\"ok\":false,\"message\":\"PIN incorrect.\"}");return;}
 JsonDocument d;if(!parse(server.arg("plain"),d)){sendJ(400,"{\"ok\":false,\"message\":\"Invalid JSON.\"}");return;}
 String pin=d["pin"]|String("");int64_t mx=d["maxAdditionSeconds"]|((int64_t)maxAdd);
 if(pin.length()<8||mx<0||mx>365LL*86400){sendJ(400,"{\"ok\":false,\"message\":\"PIN must be 8+ chars and maximum addition 0–365 days.\"}");return;}
 prefs.begin("timersync",false);prefs.putString("pin",pin);String v;
 #define SAVE_FIELD(field,key) v=d[field]|String("");if(!v.isEmpty())prefs.putString(key,v)
 SAVE_FIELD("chasterLock","cl");SAVE_FIELD("chasterToken","ct");SAVE_FIELD("chastifyLock","fl");SAVE_FIELD("chastifyToken","ft");SAVE_FIELD("emlaUser","eu");SAVE_FIELD("emlaKey","ek");
 prefs.putUInt("maxadd",(uint32_t)mx);prefs.end();load();sendJ(200,"{\"ok\":true,\"message\":\"Saved. Secrets are never returned to the browser.\"}");
}
void setupPortal(){
 WiFi.mode(WIFI_AP_STA);WiFi.softAP(AP_NAME);dns.start(53,"*",WiFi.softAPIP());
 server.on("/",HTTP_GET,[]{server.send(200,"text/html",R"HTML(<!doctype html><html><meta name="viewport" content="width=device-width"><title>Timer Sync Wi-Fi</title><body style="font:16px system-ui;max-width:520px;margin:30px auto;padding:12px"><h1>Timer Sync Wi-Fi setup</h1><form method="post" action="/wifi"><label>Home Wi-Fi name (SSID)<br><input name="ssid" required></label><p><label>Password<br><input name="password" type="password"></label></p><button>Save and restart</button></form></body></html>)HTML");});
 server.on("/wifi",HTTP_POST,[]{String s=server.arg("ssid"),p=server.arg("password");if(s.isEmpty()||s.length()>32||p.length()>64){server.send(400,"text/plain","Invalid Wi-Fi values");return;}prefs.begin("timersync",false);prefs.putString("ssid",s);prefs.putString("wpass",p);prefs.end();server.send(200,"text/plain","Saved. Restarting.");delay(500);ESP.restart();});
 server.onNotFound([]{server.sendHeader("Location","http://192.168.4.1/");server.send(302,"text/plain","Setup portal");});server.begin();Serial.println("Connect to TimerSync-Setup; open http://192.168.4.1");
}
void setupRoutes(){
 const char *hs[]={"X-Admin-Pin"};server.collectHeaders(hs,1);
 server.on("/",HTTP_GET,[]{server.send(200,"text/html",html());});
 server.on("/api/state",HTTP_GET,[]{sendJ(200,stateJson());});
 server.on("/api/preview",HTTP_GET,[]{
  if(busy){sendJ(409,"{\"ok\":false,\"message\":\"Busy\"}");return;}
  Reading r[3]={{"chaster",false,0,""},{"chastify",false,0,""},{"emlalock",false,0,""}};bool all=true;int64_t target=0;
  for(int i=0;i<3;i++){r[i].ok=readSvc(i,r[i].seconds,r[i].error);if(!r[i].ok)all=false;else target=max(target,r[i].seconds);}
  String o="{\"ok\":"+String(all?"true":"false")+",\"writable\":"+(all&&!caPem.isEmpty()?"true":"false")+",\"targetSeconds\":"+num64(target)+",\"target\":\""+dur(target)+"\",\"readings\":[";
  for(int i=0;i<3;i++){if(i)o+=",";o+="{\"service\":\""+String(r[i].name)+"\",\"ok\":"+(r[i].ok?"true":"false");if(r[i].ok)o+=",\"seconds\":"+num64(r[i].seconds)+",\"remaining\":\""+dur(r[i].seconds)+"\"";else o+=",\"error\":\""+esc(r[i].error)+"\"";o+="}";}
  o+="],\"changes\":[";if(all)for(int i=0;i<3;i++){if(i)o+=",";int64_t a=target-r[i].seconds;o+="{\"service\":\""+String(r[i].name)+"\",\"beforeSeconds\":"+num64(r[i].seconds)+",\"addSeconds\":"+num64(a)+",\"add\":\""+dur(a)+"\",\"allowed\":"+(a<=maxAdd?"true":"false")+"}";}
  o+="],\"message\":\""+String(all?"Preview only; no changes sent.":"All timers must be readable; no changes sent.")+"\"}";sendJ(200,o);
 });
 server.on("/api/sync",HTTP_POST,[]{if(!auth()){sendJ(401,"{\"ok\":false,\"message\":\"PIN required or incorrect.\"}");return;}String out=runSyncCore();JsonDocument d;parse(out,d);sendJ(d["ok"].as<bool>()?200:400,out);});
 server.on("/api/settings",HTTP_POST,saveSettings);
 server.on("/api/auto",HTTP_POST,[]{if(!auth()){sendJ(401,"{\"ok\":false,\"message\":\"PIN required or incorrect.\"}");return;}JsonDocument d;parse(server.arg("plain"),d);autoSync=d["enabled"]|false;lastAuto=millis();sendJ(200,stateJson());});
 server.onNotFound([]{server.send(404,"text/plain","Not found");});server.begin();
}
void setup(){
 Serial.begin(115200);delay(200);LittleFS.begin(true);if(LittleFS.exists("/ca.pem")){File f=LittleFS.open("/ca.pem","r");caPem=f.readString();f.close();}
 load();if(wifiSsid.isEmpty()){setupPortal();return;}
 WiFi.mode(WIFI_STA);WiFi.begin(wifiSsid.c_str(),wifiPassword.c_str());uint32_t t=millis();while(WiFi.status()!=WL_CONNECTED&&millis()-t<20000)delay(250);
 if(WiFi.status()!=WL_CONNECTED){setupPortal();return;}
 configTime(0,0,"pool.ntp.org","time.google.com");Serial.print("Dashboard: http://");Serial.println(WiFi.localIP());setupRoutes();
}
void loop(){
 if(WiFi.getMode()==WIFI_AP_STA)dns.processNextRequest();server.handleClient();
 if(autoSync&&!busy&&WiFi.status()==WL_CONNECTED&&millis()-lastAuto>=INTERVAL_MS){lastAuto=millis();lastStatus=runSyncCore();}
 delay(2);
}
