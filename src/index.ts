import { Context, Schema } from 'koishi'

export const name = 'steam-status-subscribe'

export interface Config {
  endpoint: string;
  key: string;
  interval: number;
}

export const Config: Schema<Config> = Schema.object({
  endpoint: Schema.string().default('https://api.steampowered.com/'),
  key: Schema.string().required(),
  interval: Schema.number().default(10000).description("轮询间隔")
})

export interface SteamStatus {
  personaname: string;
  steamid: string;
  lastUpdated: Date;
  target: string[];
  gameId: string;
  gameextrainfo: string;
}

declare module 'koishi' {
  interface Tables {
    steam_status: SteamStatus
  }
}

export function apply(ctx: Context, config: Config) {
  ctx.model.extend('steam_status', {
    personaname: 'string',
    steamid: 'string',
    lastUpdated: 'timestamp',
    target: 'list',
    gameId: 'string',
    gameextrainfo: 'string'
  }, {
    primary: 'steamid'
  })
  const http = ctx.http.extend({
    endpoint: config.endpoint
  })
  ctx.command('steam.delete <steamid:string>', '删除在本群的监听', { checkArgCount: true })
    .action(async ({ session }, steamid) => {
      const [inDb] = await ctx.database.get('steam_status', {
        steamid
      })
      if (!inDb) {
        return '无记录!'
      }
      if (!inDb.target.includes(session.cid)) {
        return '没有在本群监听!'
      }
      if (inDb.target.length - 1 === 0) {
        await ctx.database.remove('steam_status', { steamid })
      } else {
        await ctx.database.upsert('steam_status', [{
          target: inDb.target.filter(v => v !== session.cid),
          steamid: inDb.steamid
        }])
      }
      return `删除成功`
    })
  ctx.command('steam.list', '列出在本群的监听')
    .action(async ({ session }) => {
      let list = await ctx.database.get('steam_status', {
        target: { $el: session.cid }
      })
      return list.map(v => `[${v.steamid}] ${v.personaname}`).join('\n')
    })
  ctx.command('steam.watch <input:string>', '创建监听', { checkArgCount: true })
    .usage('可输入自定义 URL 的值或 steamid。\n自定义 URL获取：个人资料页面右键复制 URL')
    .action(async ({ session }, input) => {
      let vanityMatch = input.match(/https?\:\/\/steamcommunity.com\/id\/([A-Za-z_0-9]+)/)
      let vanityInput = vanityMatch?.[1] || input
      // @TODO https://steamcommunity.com/profile/

      // get by vanity
      let r = await http.get('/ISteamUser/ResolveVanityURL/v0001/', {
        params: {
          key: config.key,
          vanityurl: vanityInput
        }
      })
      // 42: not match
      if (r.response.success === 42 && !/[0-9]{8,}/.test(input)) {
        return `无此用户`
      }
      let steamid = r.response.success === 42 && /[0-9]{8,}/.test(input) ? input : r.response.steamid

      let userInfo = await http.get('/ISteamUser/GetPlayerSummaries/v0002/', {
        params: {
          key: config.key,
          steamids: steamid
        }
      })
      if (userInfo.response.players.length === 0) {
        return `无此用户`
      }
      steamid = userInfo.response.players[0].steamid
      const [inDb] = await ctx.database.get('steam_status', {
        steamid
      })

      if (!inDb) {
        await ctx.database.create('steam_status', {
          steamid, personaname: userInfo.response.players[0].personaname, target: [session.cid]
        })
      } else {
        await ctx.database.upsert('steam_status', [{
          target: [...new Set([...inDb.target, session.cid])],
          steamid: inDb.steamid
        }])
      }
      return `绑定成功, steamid: ${steamid}, personaname: ${userInfo.response.players[0].personaname}`
    })
  ctx.setInterval(async () => {
    let list = await ctx.database.get('steam_status', {})
    let r = await http.get('/ISteamUser/GetPlayerSummaries/v0002/', {
      params: {
        key: config.key,
        steamids: list.map(v => v.steamid).join(',')
      }
    })
    for (const user of r.response.players) {
      const inDb = list.find(v => v.steamid === user.steamid)
      let { gameId: dbGameid } = inDb
      let { personaname, gameextrainfo, gameid } = user
      gameid ||= null
      dbGameid ||= null
      if (dbGameid !== gameid) {
        if (!dbGameid) {
          ctx.broadcast(inDb.target, `${personaname} 正在玩: ${gameextrainfo}`)
        }
        if (!gameid && dbGameid) {
          ctx.broadcast(inDb.target, `${personaname} 玩了 ${Math.ceil((new Date().valueOf() - inDb.lastUpdated.valueOf()) / 1000 / 60)} 分钟后, 不玩 ${inDb.gameextrainfo} 了`)
        }
        if (dbGameid && gameid) {
          ctx.broadcast(inDb.target, `${personaname} 玩了 ${Math.ceil((new Date().valueOf() - inDb.lastUpdated.valueOf()) / 1000 / 60)} 分钟后, 不玩 ${inDb.gameextrainfo} 了, 开始玩 ${gameextrainfo}`)
        }
        ctx.database.upsert('steam_status', [{ gameId: gameid, gameextrainfo, steamid: inDb.steamid, lastUpdated: new Date() }])
      }
    }
  }, config.interval)
}
