/**
 * 京东每日签到 - Quantumult X 版
 * ============================================
 * 一个脚本两种模式：
 *  ① 重写模式（script-request-header）：挂在京东 API 请求上，打开京东 App「我的」页自动抓取 Cookie
 *  ② 定时任务模式：读取已保存的 Cookie 执行签到，通知「本次获得 + 当前总数」
 *
 * QX 配置（把 <URL> 替换为本文件的直链）：
 * [rewrite_local]
 * ^https?:\/\/(api\.m|me-api)\.jd\.com\/ url script-request-header <URL>
 *
 * [task_local]
 * 23 7 * * * <URL>
 *
 * [mitm]
 * hostname = api.m.jd.com, me-api.jd.com
 *
 * v1.1：存储改用 QX 官方 $prefs（QX 无 $persistentStore，那是 Surge/Loon 的 API）
 * v1.2：签到结果必写日志（不依赖通知）；25 秒看门狗防请求挂起静默无结果
 * v1.3：签到改走已验证的 signed_wh5_ihub H5 入口（真实 App 请求形状+完整头），
 *       修复 code=402「挤不进去」；402/S109 均自动重试（间隔 5 秒），看门狗放宽到 90 秒
 */

var KEY = 'JD_QX_COOKIE'
var RETRY = 3 // 被限流(S109)时的自动重试次数

// ---------- 基础工具 ----------
function log(m) { console.log(m) }
function notify(t, s, b) { $notify(t, s, b || '') }

// 持久化存储：QX 官方 API 是 $prefs（valueForKey / setValueForKey，注意 value 在前、key 在后）
// $persistentStore 是 Surge/Loon 的 API，QX 里不存在，这里仅作跨平台兜底
function storeRead(k) {
  try { if (typeof $prefs !== 'undefined' && $prefs.valueForKey) return $prefs.valueForKey(k) } catch (e) {}
  try { if (typeof $persistentStore !== 'undefined') return $persistentStore.read(k) } catch (e) {}
  return null
}
function storeWrite(v, k) {
  try { if (typeof $prefs !== 'undefined' && $prefs.setValueForKey) return $prefs.setValueForKey(v, k) } catch (e) {}
  try { if (typeof $persistentStore !== 'undefined') return $persistentStore.write(v, k) } catch (e) {}
  return false
}

function randHex(n) {
  var c = '0123456789abcdef', s = ''
  for (var i = 0; i < n; i++) s += c.charAt(Math.floor(Math.random() * 16))
  return s
}

var MODELS = ['iPhone13,2', 'iPhone14,3', 'iPhone11,8', 'iPhone12,1', 'iPhone15,2']

// 每次请求生成随机设备指纹，模拟 iPhone App 客户端
function buildClient() {
  var id = randHex(32)
  var model = MODELS[Math.floor(Math.random() * MODELS.length)]
  var osv = (14 + Math.floor(Math.random() * 3)) + '.' + (1 + Math.floor(Math.random() * 7))
  var appver = '11.3.1'
  var ua = 'jdapp;iPhone;' + appver + ';' + osv + ';' + id + ';network/wifi;model/' + model +
    ';hasUPPay/0;pushNoticeIsOpen/0;jdSupportDarkMode/0;Mozilla/5.0 (iPhone; CPU iPhone OS ' +
    osv + ' like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'
  var url = 'https://api.m.jd.com/client.action?functionId=signBeanAct' +
    '&body=%7B%22fp%22%3A%22-1%22%2C%22shshshfp%22%3A%22-1%22%2C%22shshshfpa%22%3A%22-1%22%2C%22referUrl%22%3A%22-1%22%2C%22userAgent%22%3A%22-1%22%2C%22jda%22%3A%22-1%22%2C%22rnVersion%22%3A%223.9%22%7D' +
    '&appid=ld&client=apple&clientVersion=' + appver + '&networkType=wifi&osVersion=' + osv +
    '&uuid=' + id + '&openudid=' + id
  return { url: url, ua: ua }
}

function parseResp(text) {
  text = (text || '').trim()
  var s = text.indexOf('('), e = text.lastIndexOf(')')
  if (s > -1 && e > s && text.slice(-1) === ')') text = text.slice(s + 1, e)
  return JSON.parse(text)
}

function getPin(cookie) {
  var m = cookie.match(/pt_pin=([^;]+)/)
  if (!m) return '京东账号'
  try { return decodeURIComponent(m[1]) } catch (e) { return m[1] }
}

function http(opts) {
  return new Promise(function (resolve, reject) {
    $task.fetch(opts).then(resolve, reject)
  })
}

// ---------- 京东接口 ----------
// 签到请求形状：沿用社区已验证的真实 App 请求（signed_wh5_ihub H5 入口），
// 旧的 appid=ld + 假指纹 body 会被活动网关弹回 code=402「挤不进去」
var SIGN_URL = 'https://api.m.jd.com/client.action?functionId=signBeanAct'
var SIGN_BODY = 'functionId=signBeanAct&body=%7B%7D&appid=signed_wh5_ihub&client=apple&screen=430*749&networkType=wifi&openudid=79e7a95afb54c4997187d2a1c105b408ebe5aebd&uuid=79e7a95afb54c4997187d2a1c105b408ebe5aebd&clientVersion=15.1.65&d_model=iPhone16%2C2&osVersion=18.5'
var SIGN_UA = 'jdapp;iPhone;15.1.65;;;M/5.0;appBuild/169923;jdSupportDarkMode/1;lang/zh_CN;site/CN;elder/0;ef/1;ep/%7B%22ciphertype%22%3A5%2C%22cipher%22%3A%7B%22ud%22%3A%22DzvvD2O5DWPwYtU0YzG5EJcnENduCwOnYzOmDWS0CNrvYwU1YWVsZK%3D%3D%22%2C%22sv%22%3A%22CJqkDG%3D%3D%22%2C%22iad%22%3A%22%22%7D%2C%22ts%22%3A1751935372%2C%22hdid%22%3A%22JM9F1ywUPwflvMIpYPok0tt5k9kW4ArJEU3lfLhxBqw%3D%22%2C%22version%22%3A%221.0.3%22%2C%22appname%22%3A%22com.360buy.jdmobile%22%2C%22ridx%22%3A-1%7D;Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148;supportJDSHWK/1;'
var SIGN_PAGE = 'https://pro.m.jd.com/mall/active/Md9FMi1pJXg2q7qc8CmE9FNYDS4/index.html'

// 查询当前京豆总数（失败返回 -1）
function queryBeans(cookie) {
  var c = buildClient()
  return http({
    url: 'https://me-api.jd.com/user_new/info/GetJDUserInfoUnion',
    method: 'GET',
    headers: { 'Cookie': cookie, 'User-Agent': c.ua, 'Referer': 'https://home.m.jd.com/' },
    timeout: 15000
  }).then(function (resp) {
    if (resp.statusCode !== 200) return -1
    var text = resp.body
    var n = 0
    try { n = parseInt(parseResp(text).data.assetInfo.beanNum) || 0 } catch (e) {}
    if (!n) { var m = text.match(/"beanNum"\s*:\s*"?(\d+)/); if (m) n = parseInt(m[1]) }
    return n
  }, function () { return -1 })
}

// 执行签到，state: ok / unknown / blocked(拦截) / fail
function doSign(cookie) {
  return http({
    url: SIGN_URL,
    method: 'POST',
    headers: {
      'Cookie': cookie,
      'User-Agent': SIGN_UA,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Origin': 'https://pro.m.jd.com',
      'Referer': SIGN_PAGE,
      'x-referer-page': SIGN_PAGE,
      'x-rp-client': 'h5_1.0.0',
      'request-from': 'native',
      'Accept': '*/*',
      'Accept-Language': 'zh-CN,zh-Hans;q=0.9'
    },
    body: SIGN_BODY,
    timeout: 15000
  }).then(function (resp) {
    if (resp.statusCode !== 200) return { state: 'fail', msg: '请求失败 HTTP ' + resp.statusCode, beans: 0 }
    var text = resp.body
    var data
    try { data = parseResp(text) } catch (e) { return { state: 'fail', msg: '返回解析失败', beans: 0 } }
    var raw = JSON.stringify(data)
    var code = String(data.code)
    if (code === '3' || code === '13' || raw.indexOf('登录') > -1 || raw.indexOf('pt_key') > -1) {
      return { state: 'fail', msg: 'Cookie 已失效，请打开京东 App「我的」页重新获取', beans: 0 }
    }
    var msg = ''
    try { msg = String(data.errorMessage || data.message || data.msg || '') } catch (e) {}
    if (code === '402' || msg.indexOf('挤不进去') > -1 || msg.indexOf('稍晚') > -1 || msg.indexOf('人数较多') > -1) {
      return { state: 'blocked', msg: '被拦截(' + code + ' ' + msg + ')', beans: 0 }
    }
    if (code !== '0') return { state: 'fail', msg: 'code=' + code + ' ' + msg, beans: 0 }
    // code=0：status 1=本次签到成功 2=今日已签到
    var d = (typeof data.data === 'object' && data.data) ? data.data : {}
    var status = String(d.status || '')
    var award = d.dailyAward || d.continuityAward || d.newUserAward || {}
    var beans = 0
    try { beans = parseInt(award.beanAward.beanCount) || 0 } catch (e) {}
    if (!beans) { try { beans = parseInt(award.awardList[0].beanCount) || 0 } catch (e) {} }
    if (!beans) { var m = raw.match(/"bean(?:Count|Num)"\s*:\s*"?(\d+)/); if (m) beans = parseInt(m[1]) }
    var days = ''
    try { days = String(d.continuousDays) } catch (e) {}
    if (!days) { var m2 = raw.match(/"continuousDays"\s*:\s*"?(\d+)/); if (m2) days = m2[1] }
    var tail = (beans ? ' +' + beans + ' 京豆' : '') + (days ? '，连续 ' + days + ' 天' : '')
    if (status === '1') return { state: 'ok', msg: '签到成功' + tail, beans: beans }
    if (status === '2') return { state: 'ok', msg: '今日已签到' + tail, beans: 0 }
    if (raw.indexOf('已签到') > -1) return { state: 'ok', msg: '今日已签到' + tail, beans: 0 }
    if (beans > 0 || raw.indexOf('签到成功') > -1 || raw.indexOf('签到奖励') > -1) {
      return { state: 'ok', msg: '签到成功' + tail, beans: beans }
    }
    return { state: 'unknown', msg: '接口正常但未检测到奖励', beans: 0 }
  }, function (err) {
    var m = (err && err.message) ? err.message : (typeof err === 'string' ? err : JSON.stringify(err))
    return { state: 'fail', msg: '请求异常：' + m, beans: 0 }
  })
}

// 被拦截时自动重试（402 挤不进去 / S109 通常稍等即可通过，间隔 5 秒）
function trySign(cookie, n, last) {
  if (n > RETRY) return Promise.resolve(last || { state: 'fail', msg: '重试后仍被拦截', beans: 0 })
  return doSign(cookie).then(function (r) {
    if (r.state === 'blocked' && n <= RETRY) {
      log('第 ' + n + ' 次被拦，5 秒后重试…')
      return new Promise(function (res) {
        setTimeout(function () { res(trySign(cookie, n + 1, r)) }, 5000)
      })
    }
    return r
  })
}

// ---------- 定时任务模式 ----------
function taskMain() {
  var cookie = storeRead(KEY)
  if (!cookie || cookie.indexOf('pt_key=') === -1) {
    notify('京东签到 ❌', '未找到 Cookie', '请先打开京东 App 到「我的」页面，自动获取 Cookie')
    return $done()
  }
  var pin = getPin(cookie)
  var doneFlag = false
  function onceDone() { if (!doneFlag) { doneFlag = true; $done() } }
  // 看门狗：90 秒未结束则记录并通知，防止请求挂起导致静默无结果（最长 4 次尝试+间隔约 40 秒）
  setTimeout(function () {
    if (!doneFlag) {
      log('⚠️ 90 秒未完成，疑似签到请求挂起')
      notify('京东签到 ⚠️', '流程超时', '签到请求长时间无响应，脚本已中止')
      doneFlag = true
      $done()
    }
  }, 90000)
  var before = -1
  queryBeans(cookie).then(function (n) {
    before = n
    log(pin + ' 签到前京豆：' + before)
    log('开始签到…')
    return trySign(cookie, 1, null)
  }).then(function (r) {
    log(pin + ' 签到结果：[' + r.state + '] ' + r.msg)
    var gained = r.beans
    var after = -2
    var p
    if (r.state === 'ok' || r.state === 'unknown') {
      p = queryBeans(cookie).then(function (a) {
        after = a
        if (after >= 0 && !gained && before >= 0 && after > before) gained = after - before
      }, function () {})
    } else {
      p = Promise.resolve()
    }
    return p.then(function () {
      var tag = r.state === 'ok' ? '' : (r.state === 'unknown' ? '⚠️ ' : '❌ ')
      var extra = ''
      if (gained > 0 && r.msg.indexOf('+') === -1) extra += '，本次 +' + gained
      if (after >= 0) extra += '，当前共 ' + after + ' 京豆'
      else if (before >= 0 && r.state !== 'ok') extra += '，签到前共 ' + before + ' 京豆'
      notify('京东签到' + (tag ? ' ' + tag : ''), pin + '：' + r.msg + extra, '')
      onceDone()
    })
  }).catch(function (e) {
    var m = (e && e.message) ? e.message : String(e)
    log('运行异常：' + m)
    notify('京东签到 ❌', '运行异常', m)
    onceDone()
  })
}

// ---------- 入口：区分抓包模式与定时任务模式 ----------
if (typeof $request !== 'undefined') {
  try {
    var h = $request.headers || {}
    var ck = h['Cookie'] || h['cookie'] || ''
    if (ck.indexOf('pt_key=') > -1 && ck.indexOf('pt_pin=') > -1) {
      var old = storeRead(KEY)
      if (old === ck) {
        log('Cookie 未变化，跳过')
      } else if (storeWrite(ck, KEY)) {
        notify('京东 Cookie', '✅ 已获取：' + getPin(ck), '可到「定时任务」手动运行一次签到测试')
      } else {
        notify('京东 Cookie', '⚠️ 已抓到但保存失败', '请重试或反馈日志')
      }
    }
  } catch (e) {
    log('Cookie 抓取异常：' + e)
  }
  $done({})
} else {
  taskMain()
}
