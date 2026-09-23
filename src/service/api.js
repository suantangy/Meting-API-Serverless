import Meting from '@meting/core'
import aesjs from 'aes-js'
import { createHash } from 'crypto'
import hashjs from 'hash.js'
import { HTTPException } from 'hono/http-exception'
import { loadConfig } from '../config.js'
import { format as lyricFormat } from '../utils/lyric.js'
import { readCookieAsync, isAllowedHost } from '../utils/cookie.js'
import { LRUCache } from 'lru-cache'

const cache = new LRUCache({
  max: 1000,
  ttl: 1000 * 30
})

// ============================================================
// 网易云 Cloudflare Workers AES-ECB 修复
// ============================================================

const patchNeteaseEapiEncrypt = (meting) => {
  const provider = meting?.provider

  if (!provider || provider.name !== 'netease') return

  const proto = Object.getPrototypeOf(provider)

  if (proto.__patchedEapi) return

  proto.__patchedEapi = true

  proto.eapiEncrypt = (req) => {
    const bodyStr = JSON.stringify(req.body)
    const path = req.url.replace(/https?:\/\/[^/]+/, '')

    const signSeed =
      `nobody${path}use${bodyStr}md5forencrypt`

    const sign = createHash('md5')
      .update(signSeed)
      .digest('hex')

    const payload =
      `${path}-36cd479b6b5-${bodyStr}-36cd479b6b5-${sign}`

    const key = Buffer.from(
      'e82ckenh8dichen8',
      'utf8'
    )

    const textBytes = Buffer.from(
      payload,
      'utf8'
    )

    const padded =
      aesjs.padding.pkcs7.pad(textBytes)

    const aesEcb =
      new aesjs.ModeOfOperation.ecb(key)

    const encryptedBytes =
      aesEcb.encrypt(padded)

    const encryptedHex =
      Buffer.from(encryptedBytes)
        .toString('hex')
        .toUpperCase()

    req.url =
      req.url.replace('/api/', '/eapi/')

    req.body = {
      params: encryptedHex
    }

    return req
  }
}


// ============================================================
// QQ 音乐请求公共 Header
// ============================================================

const QQ_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',

  'Referer':
    'https://y.qq.com/',

  'Accept':
    'application/json, text/plain, */*'
}


// ============================================================
// QQ 音乐：新版搜索
//
// QQ 旧的 c.y.qq.com 搜索接口已经容易出现空结果。
// 新接口：
// https://u.y.qq.com/cgi-bin/musicu.fcg
//
// DoSearchForQQMusicDesktop
// ============================================================

async function tencentSearch(keyword, cookie = '') {
  const body = {
    comm: {
      ct: 19,
      cv: '1859',
      uin: '0'
    },

    req: {
      method: 'DoSearchForQQMusicDesktop',

      module:
        'music.search.SearchCgiService',

      param: {
        grp: 1,
        num_per_page: 20,
        page_num: 1,
        query: keyword,
        search_type: 0
      }
    }
  }

  const headers = {
    ...QQ_HEADERS,
    'Content-Type':
      'application/json;charset=UTF-8'
  }

  if (cookie) {
    headers.Cookie = cookie
  }

  const response = await fetch(
    'https://u.y.qq.com/cgi-bin/musicu.fcg',
    {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    }
  )

  if (!response.ok) {
    throw new Error(
      `QQ搜索 HTTP ${response.status}`
    )
  }

  const result = await response.json()

  const song =
    result?.req?.data?.body?.song

  if (!song) {
    return []
  }

  const list =
    Array.isArray(song.list)
      ? song.list
      : []

  return list.map((item) => {
    const singer =
      Array.isArray(item.singer)
        ? item.singer
            .map(x => x.name)
            .filter(Boolean)
            .join(' / ')
        : ''

    const albumMid =
      item.album?.mid ||
      item.albummid ||
      ''

    const songMid =
      item.mid ||
      item.songmid ||
      ''

    return {
      name: item.name || '',
      artist: singer,
      url_id: songMid,
      pic_id: albumMid,
      lyric_id: songMid
    }
  }).filter(item => item.url_id)
}


// ============================================================
// QQ 音乐：新版播放地址
//
// API:
// https://u.y.qq.com/cgi-bin/musicu.fcg
//
// vkey.GetVkeyServer
// CgiGetVkey
// ============================================================

async function tencentUrl(songMid, cookie = '') {
  const body = {
    req_1: {
      module:
        'vkey.GetVkeyServer',

      method:
        'CgiGetVkey',

      param: {
        filename: [
          `M800${songMid}.mp3`
        ],

        guid: String(
          Math.floor(
            1000000000 +
            Math.random() * 9000000000
          )
        ),

        songmid: [
          songMid
        ],

        songtype: [
          0
        ],

        uin: '0',

        loginflag: 1,

        platform: '20'
      }
    },

    loginUin: '0',

    comm: {
      uin: '0',
      format: 'json',
      ct: 24,
      cv: 0
    }
  }

  const headers = {
    ...QQ_HEADERS,
    'Content-Type':
      'application/json;charset=UTF-8'
  }

  if (cookie) {
    headers.Cookie = cookie
  }

  const response = await fetch(
    'https://u.y.qq.com/cgi-bin/musicu.fcg',
    {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    }
  )

  if (!response.ok) {
    throw new Error(
      `QQ播放地址 HTTP ${response.status}`
    )
  }

  const result = await response.json()

  const data =
    result?.req_1?.data

  if (!data) {
    return ''
  }

  const sip =
    Array.isArray(data.sip)
      ? data.sip
      : []

  const midurlinfo =
    Array.isArray(data.midurlinfo)
      ? data.midurlinfo
      : []

  if (!sip.length || !midurlinfo.length) {
    return ''
  }

  const purl =
    midurlinfo[0]?.purl || ''

  if (!purl) {
    return ''
  }

  let base = sip[0] || ''

  if (
    !base.endsWith('/') &&
    !purl.startsWith('/')
  ) {
    base += '/'
  }

  return base + purl
}


// ============================================================
// QQ 音乐：搜索结果统一格式
// ============================================================

function formatTencentSearchResult(
  data,
  baseUrl,
  token
) {
  return data.map(x => {
    return {
      title: x.name,

      author:
        x.artist || '',

      url:
        `${baseUrl}/api?server=tencent&type=url&id=${encodeURIComponent(x.url_id)}&auth=${auth(
          'tencent',
          'url',
          x.url_id,
          token
        )}`,

      pic:
        `${baseUrl}/api?server=tencent&type=pic&id=${encodeURIComponent(x.pic_id)}&auth=${auth(
          'tencent',
          'pic',
          x.pic_id,
          token
        )}`,

      lrc:
        `${baseUrl}/api?server=tencent&type=lrc&id=${encodeURIComponent(x.lyric_id)}&auth=${auth(
          'tencent',
          'lrc',
          x.lyric_id,
          token
        )}`
    }
  })
}


// ============================================================
// API 方法
// ============================================================

const METING_METHODS = {
  search: 'search',
  song: 'song',
  album: 'album',
  artist: 'artist',
  playlist: 'playlist',
  lrc: 'lyric',
  url: 'url',
  pic: 'pic'
}


// ============================================================
// 主 API
// ============================================================

export default async (c) => {
  const config =
    loadConfig(c.env, c.req.url)

  const baseUrl =
    config.meting.url ||
    new URL(c.req.url).origin

  const token =
    config.meting.token || 'token'

  const query =
    c.req.query()

  const server =
    query.server || 'netease'

  const type =
    query.type || 'search'

  const id =
    query.id || 'hello'

  const authToken =
    query.token ||
    query.auth ||
    token


  // ----------------------------------------------------------
  // 参数检查
  // ----------------------------------------------------------

  if (
    ![
      'netease',
      'tencent',
      'kugou',
      'baidu',
      'kuwo'
    ].includes(server)
  ) {
    throw new HTTPException(400, {
      message:
        'server 参数不合法'
    })
  }

  if (
    ![
      'song',
      'album',
      'search',
      'artist',
      'playlist',
      'lrc',
      'url',
      'pic'
    ].includes(type)
  ) {
    throw new HTTPException(400, {
      message:
        'type 参数不合法'
    })
  }


  // ----------------------------------------------------------
  // 鉴权
  // ----------------------------------------------------------

  if (
    ['lrc', 'url', 'pic']
      .includes(type)
  ) {
    if (
      auth(
        server,
        type,
        id,
        token
      ) !== authToken
    ) {
      throw new HTTPException(401, {
        message:
          '鉴权失败,非法调用'
      })
    }
  }


  // ----------------------------------------------------------
  // 获取 QQ Cookie
  // ----------------------------------------------------------

  let cookie = ''

  const referrer =
    c.req.header('referer')

  if (
    isAllowedHost(
      referrer,
      config.meting.cookie.allowHosts
    )
  ) {
    cookie =
      await readCookieAsync(
        server,
        c.env
      )
  }


  // ==========================================================
  // QQ 音乐特殊处理
  // ==========================================================

  if (
    server === 'tencent' &&
    type === 'search'
  ) {
    try {
      const cacheKey =
        `tencent/search/${id}`

      let data =
        cache.get(cacheKey)

      if (data === undefined) {
        data =
          await tencentSearch(
            id,
            cookie
          )

        cache.set(
          cacheKey,
          data,
          {
            ttl: 1000 * 60 * 10
          }
        )
      }

      return c.json(
        formatTencentSearchResult(
          data,
          baseUrl,
          token
        )
      )

    } catch (error) {
      console.error(
        'Tencent search error:',
        error
      )

      throw new HTTPException(
        502,
        {
          message:
            `QQ音乐搜索失败：${error?.message || '未知错误'}`
        }
      )
    }
  }


  // ==========================================================
  // QQ 音乐新版播放地址
  // ==========================================================

  if (
    server === 'tencent' &&
    type === 'url'
  ) {
    try {
      const cacheKey =
        `tencent/url/${id}`

      let url =
        cache.get(cacheKey)

      if (url === undefined) {
        url =
          await tencentUrl(
            id,
            cookie
          )

        if (!url) {
          throw new Error(
            'QQ音乐没有返回可用播放地址'
          )
        }

        cache.set(
          cacheKey,
          url,
          {
            ttl: 1000 * 60 * 10
          }
        )
      }

      return c.redirect(url)

    } catch (error) {
      console.error(
        'Tencent URL error:',
        error
      )

      throw new HTTPException(
        404,
        {
          message:
            `QQ音乐播放地址获取失败：${error?.message || '未知错误'}`
        }
      )
    }
  }


  // ==========================================================
  // 其他功能继续使用 @meting/core
  // ==========================================================

  const cacheKey =
    `${server}/${type}/${id}`

  let data =
    cache.get(cacheKey)

  if (data === undefined) {

    c.header(
      'x-cache',
      'miss'
    )

    const meting =
      new Meting(server)

    patchNeteaseEapiEncrypt(
      meting
    )

    meting.format(true)


    // --------------------------------------------------------
    // 配置 Cookie
    // --------------------------------------------------------

    if (
      cookie
    ) {
      meting.cookie(cookie)
    }


    const method =
      METING_METHODS[type]

    let response

    try {
      response =
        await meting[method](id)

    } catch (error) {

      console.error(error)

      throw new HTTPException(
        500,
        {
          message:
            '上游 API 调用失败'
        }
      )
    }


    try {
      data =
        JSON.parse(response)

    } catch (error) {

      throw new HTTPException(
        500,
        {
          message:
            '上游 API 返回格式异常'
        }
      )
    }


    cache.set(
      cacheKey,
      data,
      {
        ttl:
          type === 'url'
            ? 1000 * 60 * 10
            : 1000 * 60 * 60
      }
    )
  }


  // ==========================================================
  // URL
  // ==========================================================

  if (
    type === 'url'
  ) {

    let url =
      data.url

    if (!url) {
      return c.body(
        null,
        404
      )
    }

    if (
      server === 'netease'
    ) {

      url =
        url
          .replace(
            '://m7c.',
            '://m7.'
          )
          .replace(
            '://m8c.',
            '://m8.'
          )
          .replace(
            'http://',
            'https://'
          )

      if (
        url.includes('vuutv=')
      ) {
        const tempUrl =
          new URL(url)

        tempUrl.search = ''

        url =
          tempUrl.toString()
      }
    }


    if (
      server === 'baidu'
    ) {
      url =
        url
          .replace(
            'http://zhangmenshiting.qianqian.com',
            'https://gss3.baidu.com/y0s1hSulBw92lNKgpU_Z2jR7b2w6buu'
          )
    }

    return c.redirect(url)
  }


  // ==========================================================
  // 封面
  // ==========================================================

  if (
    type === 'pic'
  ) {

    const url =
      data.url

    if (!url) {
      return c.body(
        null,
        404
      )
    }

    return c.redirect(url)
  }


  // ==========================================================
  // 歌词
  // ==========================================================

  if (
    type === 'lrc'
  ) {

    return c.text(
      lyricFormat(
        data.lyric,
        data.tlyric || ''
      )
    )
  }


  // ==========================================================
  // 普通 JSON
  // ==========================================================

  return c.json(
    data.map((x) => {

      return {

        title:
          x.name,

        author:
          x.artist.join(' / '),

        url:
          `${baseUrl}/api?server=${server}&type=url&id=${encodeURIComponent(x.url_id)}&auth=${auth(
            server,
            'url',
            x.url_id,
            token
          )}`,

        pic:
          `${baseUrl}/api?server=${server}&type=pic&id=${encodeURIComponent(x.pic_id)}&auth=${auth(
            server,
            'pic',
            x.pic_id,
            token
          )}`,

        lrc:
          `${baseUrl}/api?server=${server}&type=lrc&id=${encodeURIComponent(x.lyric_id)}&auth=${auth(
            server,
            'lrc',
            x.lyric_id,
            token
          )}`
      }
    })
  )
}


// ============================================================
// HMAC-SHA1 鉴权
// ============================================================

const auth = (
  server,
  type,
  id,
  token
) => {

  return hashjs
    .hmac(
      hashjs.sha1,
      token
    )
    .update(
      `${server}${type}${id}`
    )
    .digest('hex')
}