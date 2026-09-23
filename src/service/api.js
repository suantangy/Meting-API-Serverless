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
// 网易云 EAPI AES-ECB 修复
// ============================================================

const patchNeteaseEapiEncrypt = (meting) => {
  const provider = meting?.provider

  if (!provider || provider.name !== 'netease') {
    return
  }

  const proto = Object.getPrototypeOf(provider)

  if (proto.__patchedEapi) {
    return
  }

  proto.__patchedEapi = true

  proto.eapiEncrypt = (req) => {
    const bodyStr = JSON.stringify(req.body)

    const path =
      req.url.replace(
        /https?:\/\/[^/]+/,
        ''
      )

    const signSeed =
      `nobody${path}use${bodyStr}md5forencrypt`

    const sign =
      createHash('md5')
        .update(signSeed)
        .digest('hex')

    const payload =
      `${path}-36cd479b6b5-${bodyStr}-36cd479b6b5-${sign}`

    const key =
      Buffer.from(
        'e82ckenh8dichen8',
        'utf8'
      )

    const textBytes =
      Buffer.from(
        payload,
        'utf8'
      )

    const padded =
      aesjs.padding.pkcs7.pad(
        textBytes
      )

    const aesEcb =
      new aesjs.ModeOfOperation.ecb(
        key
      )

    const encryptedBytes =
      aesEcb.encrypt(
        padded
      )

    const encryptedHex =
      Buffer.from(
        encryptedBytes
      )
        .toString('hex')
        .toUpperCase()

    req.url =
      req.url.replace(
        '/api/',
        '/eapi/'
      )

    req.body = {
      params: encryptedHex
    }

    return req
  }
}


// ============================================================
// QQ Music 请求 Header
// ============================================================

const QQ_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',

  'Referer':
    'https://y.qq.com/',

  'Origin':
    'https://y.qq.com',

  'Accept':
    'application/json, text/plain, */*'
}


// ============================================================
// QQ Music 搜索
//
// 使用 QQ Music 当前 musicu.fcg 搜索接口
//
// search:
// {
//   "music.search.SearchCgiService": {
//     "module": "music.search.SearchCgiService",
//     "method": "DoSearchForQQMusicDesktop",
//     "param": {
//       "search_type": 0,
//       "query": "周杰伦",
//       "page_num": 1,
//       "num_per_page": 20
//     }
//   }
// }
// ============================================================

async function tencentSearch(
  keyword,
  cookie = ''
) {
  const body = {
    search: {
      module:
        'music.search.SearchCgiService',

      method:
        'DoSearchForQQMusicDesktop',

      param: {
        search_type: 0,
        query: keyword,
        page_num: 1,
        num_per_page: 20
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

  const response =
    await fetch(
      'https://u.y.qq.com/cgi-bin/musicu.fcg',
      {
        method: 'POST',
        headers,
        body: JSON.stringify(body)
      }
    )

  if (!response.ok) {
    throw new Error(
      `QQ音乐搜索 HTTP ${response.status}`
    )
  }

  const result =
    await response.json()

  const song =
    result?.search?.data?.body?.song

  if (!song) {
    console.error(
      'QQ Music search response:',
      JSON.stringify(result)
    )

    return []
  }

  const list =
    Array.isArray(song.list)
      ? song.list
      : []

  return list
    .map(item => {
      const artist =
        Array.isArray(item.singer)
          ? item.singer
              .map(
                singer =>
                  singer?.name || ''
              )
              .filter(Boolean)
              .join(' / ')
          : ''

      const songMid =
        item.mid ||
        item.songmid ||
        ''

      const albumMid =
        item.album?.mid ||
        item.albummid ||
        ''

      return {
        name:
          item.name || '',

        artist,

        url_id:
          songMid,

        pic_id:
          albumMid,

        lyric_id:
          songMid
      }
    })
    .filter(
      item =>
        item.url_id
    )
}


// ============================================================
// QQ Music 获取播放地址
//
// vkey.GetVkeyServer
// CgiGetVkey
//
// 返回：sip[0] + midurlinfo[0].purl
// ============================================================

async function tencentUrl(
  songMid,
  cookie = ''
) {
  const guid =
    String(
      Math.floor(
        1000000000 +
        Math.random() *
        9000000000
      )
    )

  const body = {
    comm: {
      cv: 4747474,
      ct: 24,
      format: 'json',
      inCharset: 'utf-8',
      outCharset: 'utf-8',
      notice: 0,
      platform: 'yqq.json',
      needNewCode: 1,
      uin: 0
    },

    req_1: {
      module:
        'vkey.GetVkeyServer',

      method:
        'CgiGetVkey',

      param: {
        filename: [
          `C400${songMid}.m4a`
        ],

        guid,

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

  const response =
    await fetch(
      'https://u.y.qq.com/cgi-bin/musicu.fcg',
      {
        method: 'POST',
        headers,
        body: JSON.stringify(body)
      }
    )

  if (!response.ok) {
    throw new Error(
      `QQ音乐播放地址 HTTP ${response.status}`
    )
  }

  const result =
    await response.json()

  const data =
    result?.req_1?.data

  if (!data) {
    console.error(
      'QQ Music vkey response:',
      JSON.stringify(result)
    )

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

  if (
    sip.length === 0 ||
    midurlinfo.length === 0
  ) {
    return ''
  }

  const purl =
    midurlinfo[0]?.purl ||
    ''

  if (!purl) {
    return ''
  }

  let base =
    sip[0] || ''

  if (
    !base.endsWith('/') &&
    !purl.startsWith('/')
  ) {
    base += '/'
  }

  let url =
    base + purl

  // 强制 HTTPS
  if (
    url.startsWith('http://')
  ) {
    url =
      url.replace(
        'http://',
        'https://'
      )
  }

  return url
}


// ============================================================
// 生成 QQ 搜索结果
// ============================================================

function formatTencentSearchResult(
  data,
  baseUrl,
  token
) {
  return data.map(item => {
    return {
      title:
        item.name,

      author:
        item.artist,

      url:
        `${baseUrl}/api?server=tencent&type=url&id=${encodeURIComponent(item.url_id)}&auth=${auth(
          'tencent',
          'url',
          item.url_id,
          token
        )}`,

      pic:
        `${baseUrl}/api?server=tencent&type=pic&id=${encodeURIComponent(item.pic_id)}&auth=${auth(
          'tencent',
          'pic',
          item.pic_id,
          token
        )}`,

      lrc:
        `${baseUrl}/api?server=tencent&type=lrc&id=${encodeURIComponent(item.lyric_id)}&auth=${auth(
          'tencent',
          'lrc',
          item.lyric_id,
          token
        )}`
    }
  })
}


// ============================================================
// Meting 方法
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
    loadConfig(
      c.env,
      c.req.url
    )

  const baseUrl =
    config.meting.url ||
    new URL(
      c.req.url
    ).origin

  const token =
    config.meting.token ||
    'token'

  const query =
    c.req.query()

  const server =
    query.server ||
    'netease'

  const type =
    query.type ||
    'search'

  const id =
    query.id ||
    'hello'

  const authToken =
    query.token ||
    query.auth ||
    token


  // ==========================================================
  // 参数验证
  // ==========================================================

  if (
    ![
      'netease',
      'tencent',
      'kugou',
      'baidu',
      'kuwo'
    ].includes(server)
  ) {
    throw new HTTPException(
      400,
      {
        message:
          'server 参数不合法'
      }
    )
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
    throw new HTTPException(
      400,
      {
        message:
          'type 参数不合法'
      }
    )
  }


  // ==========================================================
  // 鉴权
  // ==========================================================

  if (
    [
      'lrc',
      'url',
      'pic'
    ].includes(type)
  ) {
    if (
      auth(
        server,
        type,
        id,
        token
      ) !== authToken
    ) {
      throw new HTTPException(
        401,
        {
          message:
            '鉴权失败,非法调用'
        }
      )
    }
  }


  // ==========================================================
  // 读取 Cookie
  // ==========================================================

  let cookie = ''

  const referrer =
    c.req.header(
      'referer'
    )

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
  // QQ Music：搜索
  // ==========================================================

  if (
    server === 'tencent' &&
    type === 'search'
  ) {
    const cacheKey =
      `tencent/search/${id}`

    let result =
      cache.get(cacheKey)

    if (
      result === undefined
    ) {
      try {
        result =
          await tencentSearch(
            id,
            cookie
          )

        cache.set(
          cacheKey,
          result,
          {
            ttl:
              1000 * 60 * 5
          }
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
              `QQ音乐搜索失败：${
                error?.message ||
                '未知错误'
              }`
          }
        )
      }
    }

    return c.json(
      formatTencentSearchResult(
        result,
        baseUrl,
        token
      )
    )
  }


  // ==========================================================
  // QQ Music：播放地址
  // ==========================================================

  if (
    server === 'tencent' &&
    type === 'url'
  ) {
    const cacheKey =
      `tencent/url/${id}`

    let url =
      cache.get(cacheKey)

    if (
      url === undefined
    ) {
      try {
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
            ttl:
              1000 * 60 * 5
          }
        )
      } catch (error) {
        console.error(
          'Tencent URL error:',
          error
        )

        throw new HTTPException(
          404,
          {
            message:
              `QQ音乐播放地址获取失败：${
                error?.message ||
                '未知错误'
              }`
          }
        )
      }
    }

    return c.redirect(url)
  }


  // ==========================================================
  // 其他平台继续使用 Meting
  // ==========================================================

  const cacheKey =
    `${server}/${type}/${id}`

  let data =
    cache.get(cacheKey)

  if (
    data === undefined
  ) {
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

    if (cookie) {
      meting.cookie(
        cookie
      )
    }


    const method =
      METING_METHODS[type]

    let response

    try {
      response =
        await meting[method](
          id
        )
    } catch (error) {
      console.error(
        error
      )

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
        JSON.parse(
          response
        )
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


    // --------------------------------------------------------
    // 网易云
    // --------------------------------------------------------

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
        url.includes(
          'vuutv='
        )
      ) {
        const tempUrl =
          new URL(url)

        tempUrl.search = ''

        url =
          tempUrl.toString()
      }
    }


    // --------------------------------------------------------
    // QQ Music
    // --------------------------------------------------------

    if (
      server === 'tencent'
    ) {
      url =
        url
          .replace(
            'http://',
            'https://'
          )
          .replace(
            '://ws.stream.qqmusic.qq.com',
            '://dl.stream.qqmusic.qq.com'
          )
    }


    // --------------------------------------------------------
    // 百度
    // --------------------------------------------------------

    if (
      server === 'baidu'
    ) {
      url =
        url.replace(
          'http://zhangmenshiting.qianqian.com',
          'https://gss3.baidu.com/y0s1hSulBw92lNKgpU_Z2jR7b2w6buu'
        )
    }

    return c.redirect(
      url
    )
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

    return c.redirect(
      url
    )
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
    data.map(x => {
      return {
        title:
          x.name,

        author:
          Array.isArray(
            x.artist
          )
            ? x.artist.join(
                ' / '
              )
            : x.artist || '',

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
// HMAC-SHA1
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
    .digest(
      'hex'
    )
}