import { MessageCircle } from 'lucide-react'
import type { AdminChannelDescriptor } from '@/features/channels/registry'
import { WechatSettings } from './wechat-settings'

export const wechatAdminDescriptor: AdminChannelDescriptor = {
  id: 'wechat',
  label: 'channels.wechat',  // resolved via useT() in the sidebar
  Icon: MessageCircle,
  Component: WechatSettings,
}
