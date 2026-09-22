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
 */

var KEY = 'JD_QX_COOKIE'
var RETRY = 3 // 被限流(S109)时的自动重试次数

// ---------- 基础工具 ----------
function log(m) { console.log(m) }
function notify(t, s, b) { $notify(t, s, b || '') }

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

// 执行签到，state: ok / unknown / blocked(限流) / fail
function doSign(cookie) {
  var c = buildClient()
  return http({
    url: c.url,
    method: 'POST',
    headers: { 'Cookie': cookie, 'User-Agent': c.ua, 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
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
    if (code !== '0') return { state: 'fail', msg: 'code=' + code + ' ' + (data.msg || data.message || ''), beans: 0 }
    var errCode = '', errMsg = ''
    try { errCode = String(data.errorCode || '') } catch (e) {}
    try { errMsg = String(data.errorMessage || '') } catch (e) {}
    if (errCode === 'S109' || errMsg.indexOf('稍晚') > -1 || errMsg.indexOf('人数较多') > -1) {
      return { state: 'blocked', msg: '被限流(' + (errCode || 'S109') + ')', beans: 0 }
    }
    if (raw.indexOf('已签到') > -1) {
      var days0 = ''
      try { days0 = data.data.signDays } catch (e) {}
      if (!days0) { var m0 = raw.match(/"signDays"\s*:\s*(\d+)/); if (m0) days0 = m0[1] }
      return { state: 'ok', msg: '今日已签到' + (days0 ? '，连续 ' + days0 + ' 天' : ''), beans: 0 }
    }
    var beans = 0
    try { beans = parseInt(data.data.dailyAward.beanAward.beanCount) || 0 } catch (e) {}
    if (!beans) { var m = raw.match(/"bean(?:Count|Num)"\s*:\s*(\d+)/); if (m) beans = parseInt(m[1]) }
    var days = ''
    try { days = data.data.signDays } catch (e) {}
    if (!days) { var m2 = raw.match(/"signDays"\s*:\s*(\d+)/); if (m2) days = m2[1] }
    if (beans > 0 || raw.indexOf('签到成功') > -1 || raw.indexOf('签到奖励') > -1) {
      return { state: 'ok', msg: '签到成功' + (beans ? ' +' + beans + ' 京豆' : '') + (days ? '，连续 ' + days + ' 天' : ''), beans: beans }
    }
    return { state: 'unknown', msg: '接口正常但未检测到奖励', beans: 0 }
  }, function (err) {
    var m = (err && err.message) ? err.message : (typeof err === 'string' ? err : JSON.stringify(err))
    return { state: 'fail', msg: '请求异常：' + m, beans: 0 }
  })
}

// 被限流时连续重试（手机真实环境，第一次一般就能通过）
function trySign(cookie, n, last) {
  if (n > RETRY) return Promise.resolve(last || { state: 'fail', msg: '重试后仍被限流', beans: 0 })
  return doSign(cookie).then(function (r) {
    if (r.state === 'blocked' && n <= RETRY) {
      log('第 ' + n + ' 次被限流，重试…')
      return trySign(cookie, n + 1, r)
    }
    return r
  })
}

// ---------- 定时任务模式 ----------
function taskMain() {
  var cookie = $persistentStore.read(KEY)
  if (!cookie || cookie.indexOf('pt_key=') === -1) {
    notify('京东签到 ❌', '未找到 Cookie', '请先打开京东 App 到「我的」页面，自动获取 Cookie')
    return $done()
  }
  var pin = getPin(cookie)
  var before = -1
  queryBeans(cookie).then(function (n) {
    before = n
    log(pin + ' 签到前京豆：' + before)
    return trySign(cookie, 1, null)
  }).then(function (r) {
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
      $done()
    })
  }).catch(function (e) {
    var m = (e && e.message) ? e.message : String(e)
    notify('京东签到 ❌', '运行异常', m)
    $done()
  })
}

// ---------- 入口：区分抓包模式与定时任务模式 ----------
if (typeof $request !== 'undefined') {
  try {
    var h = $request.headers || {}
    var ck = h['Cookie'] || h['cookie'] || ''
    if (ck.indexOf('pt_key=') > -1 && ck.indexOf('pt_pin=') > -1) {
      var old = $persistentStore.read(KEY)
      if (old === ck) {
        log('Cookie 未变化，跳过')
      } else if ($persistentStore.write(ck, KEY)) {
        notify('京东 Cookie', '✅ 已获取：' + getPin(ck), '可到「定时任务」手动运行一次签到测试')
      }
    }
  } catch (e) {}
  $done({})
} else {
  taskMain()
}
