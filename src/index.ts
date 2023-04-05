import { Context, Schema } from 'koishi'

export const name = 'steam-status-subscribe'

export interface Config {
  endpoint: string;
  key: string
}

export const Config: Schema<Config> = Schema.object({
  endpoint: Schema.string().default('https://api.steampowered.com/'),
  key: Schema.string().required()
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
  ctx.command('steam.delete <steamid:string>', '删除在本群的监听')
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
  ctx.command('steam.watch <input:string>', '创建监听')
    .usage('可输入自定义 URL 的值或 steamid。\n自定义 URL获取：个人资料页面右键复制 URL，选中 /id/ 后到最后一个斜杠之间的内容。')
    .action(async ({ session }, input) => {
      // get by vanity
      let r = await http.get('/ISteamUser/ResolveVanityURL/v0001/', {
        params: {
          key: config.key,
          vanityurl: input
        }
      })
      // 42: not match
      let steamid = r.response.success === 42 ? input : r.response.steamid
      const [inDb] = await ctx.database.get('steam_status', {
        steamid
      })
      let userInfo = await http.get('/ISteamUser/GetPlayerSummaries/v0002/', {
        params: {
          key: config.key,
          steamids: steamid
        }
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
  }, 10000)
}
