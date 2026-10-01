// ============================================================================
// cloud.js — 云存档模块（直接调用后端 API，适配同源部署 + CSRF）
// 挂到 window.CloudSave。
// ============================================================================

;(function () {
  var API_BASE = '' // 同源相对路径
  var TOKEN_KEY = 'cloud_save_token'
  var SLOT = 'main'

  function getToken() { return localStorage.getItem(TOKEN_KEY) }
  function setToken(t) { localStorage.setItem(TOKEN_KEY, t) }
  function clearToken() { localStorage.removeItem(TOKEN_KEY) }

  function getCsrfToken() {
    var m = document.cookie.match(/(?:^|; )suda-csrf-token=([^;]*)/)
    return m ? decodeURIComponent(m[1]) : ''
  }

  function apiFetch(url, opts) {
    opts = opts || {}
    opts.credentials = 'include'
    opts.headers = opts.headers || {}
    var csrf = getCsrfToken()
    if (csrf) { opts.headers['x-suda-csrf-token'] = csrf }
    var token = getToken()
    if (token) { opts.headers['Authorization'] = 'Bearer ' + token }
    if (opts.body && typeof opts.body === 'string' && !opts.headers['Content-Type']) {
      opts.headers['Content-Type'] = 'application/json'
    }
    return fetch(API_BASE + url, opts).then(function (r) {
      return r.json().catch(function () { return {} }).then(function (body) {
        if (!r.ok || body.ok === false) {
          throw new Error(body.error || body.message || ('HTTP ' + r.status))
        }
        return body
      })
    })
  }

  // 账号
  function signIn(email, password) {
    return apiFetch('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: email, password: password })
    }).then(function (body) {
      if (body.data && body.data.token) setToken(body.data.token)
      return { ok: true, user: body.data.user }
    }).catch(function (e) {
      return { ok: false, error: '账号或密码错误' }
    })
  }

  function signUp(email, password) {
    return apiFetch('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email: email, password: password })
    }).then(function (body) {
      if (body.data && body.data.token) setToken(body.data.token)
      return { ok: true, user: body.data.user }
    }).catch(function (e) {
      return { ok: false, error: e.message }
    })
  }

  function signOut() {
    return apiFetch('/api/auth/logout', { method: 'POST' }).then(function () {
      clearToken()
    }).catch(function () {
      clearToken()
    })
  }

  function isSignedIn() {
    var token = getToken()
    if (!token) return Promise.resolve(false)
    return apiFetch('/api/auth/me', { method: 'GET' }).then(function () {
      return true
    }).catch(function () {
      clearToken()
      return false
    })
  }

  // 云存档
  function uploadSave(saveStr) {
    return apiFetch('/api/save', {
      method: 'POST',
      body: JSON.stringify({ slot: SLOT, save_data: saveStr })
    }).then(function () {
      return { ok: true, updatedAt: new Date().toISOString() }
    })
  }

  function downloadSave() {
    return apiFetch('/api/save?slot=' + encodeURIComponent(SLOT), {
      method: 'GET'
    }).then(function (body) {
      if (!body.data) return null
      return { saveData: body.data.save_data, updatedAt: body.data.updated_at }
    })
  }

  // 自动同步（运行时包装 save.js 用）
  var __cloudLastUpload = 0
  var __cloudUploadBusy = false

  function cloudAutoUpload(playerStr) {
    if (typeof window.CloudSave === 'undefined') return
    if (typeof player === 'undefined') return
    var now = Date.now()
    if (now - __cloudLastUpload < 60000) return
    __cloudLastUpload = now
    if (__cloudUploadBusy) return
    __cloudUploadBusy = true
    CloudSave.isSignedIn().then(function (signed) {
      if (!signed) { __cloudUploadBusy = false; return }
      return CloudSave.uploadSave(playerStr).then(function () {
        __cloudUploadBusy = false
        localStorage.setItem(modInfo.id + '_cloud_lastSync', String(Date.now()))
      }).catch(function () { __cloudUploadBusy = false })
    }).catch(function () { __cloudUploadBusy = false })
  }

  function getCloudSaveString() {
    return LZString.compressToBase64(JSON.stringify(player))
  }

  function applyCloudSaveString(saveStr) {
    var tempPlr = Object.assign(getStartPlayer(), JSON.parse(LZString.decompressFromBase64(saveStr)))
    player = tempPlr
    player.versionType = modInfo.id
    fixSave()
    versionCheck()
    save(true)
    window.location.reload()
  }

  function cloudAutoDownload(force) {
    if (typeof window.CloudSave === 'undefined') return
    if (typeof player === 'undefined') return
    var lastSync = Number(localStorage.getItem(modInfo.id + '_cloud_lastSync') || '0')
    CloudSave.downloadSave().then(function (remote) {
      if (!remote) return
      var remoteTime = new Date(remote.updatedAt).getTime()
      if (isNaN(remoteTime)) return
      if (force || remoteTime > lastSync + 30000) {
        var when = new Date(remote.updatedAt).toLocaleString()
        if (confirm('云端有更新的存档（' + when + '），是否恢复？\n\n「确定」用云端覆盖本地，「取消」保留本地进度')) {
          applyCloudSaveString(remote.saveData)
        } else {
          localStorage.setItem(modInfo.id + '_cloud_lastSync', String(Date.now()))
        }
      }
    }).catch(function () {})
  }

  window.__cloudUploadNow = function () {
    if (typeof player === 'undefined') return Promise.resolve({ ok: false, error: '游戏尚未加载完成' })
    var str = getCloudSaveString()
    return CloudSave.uploadSave(str).then(function () {
      localStorage.setItem(modInfo.id + '_cloud_lastSync', String(Date.now()))
      return { ok: true }
    }).catch(function (e) {
      return { ok: false, error: e && e.message ? e.message : '上传失败' }
    })
  }

  window.__cloudDownloadNow = function () {
    return CloudSave.downloadSave().then(function (remote) {
      if (!remote) return { ok: false, error: '云端还没有存档' }
      applyCloudSaveString(remote.saveData)
      return { ok: true }
    }).catch(function (e) {
      return { ok: false, error: e && e.message ? e.message : '下载失败' }
    })
  }

  window.__cloudAutoDownload = cloudAutoDownload

  // 运行时包装 save() / load()（save.js 不得修改）
  function wrapSaveLoad() {
    var origSave = window.save
    if (origSave) {
      window.save = function (force) {
        origSave(force)
        if (typeof player !== 'undefined' && typeof LZString !== 'undefined') {
          var str = LZString.compressToBase64(JSON.stringify(player))
          cloudAutoUpload(str)
        }
      }
    }
    var origLoad = window.load
    if (origLoad) {
      window.load = function () {
        origLoad()
        cloudAutoDownload(false)
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wrapSaveLoad)
  } else {
    wrapSaveLoad()
  }

  window.CloudSave = {
    signIn: signIn,
    signUp: signUp,
    signOut: signOut,
    isSignedIn: isSignedIn,
    uploadSave: uploadSave,
    downloadSave: downloadSave
  }
})()
