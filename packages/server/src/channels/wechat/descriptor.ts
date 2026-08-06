import type { ServerChannelDescriptor } from '../registry.js'
import { startWechatChannel, type WechatChannel } from './handler.js'
import { createWechatRoutes } from '../../routes/wechat.js'
import { registerWechatCronDispatcher } from './cron-dispatcher.js'

export const wechatDescriptor: ServerChannelDescriptor<WechatChannel> = {
  channelType: 'wechat',
  start: (deps) => startWechatChannel(deps),
  routes: (deps) => createWechatRoutes(deps),
  shutdown: (channel) => channel.stopAll(),
  registerCronDispatcher: () => registerWechatCronDispatcher(),
}
