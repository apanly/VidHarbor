## bugfix-01 · 安全重跑删除确认的 Web 验收

- 关联 task: task-20
- 描述: task-19 的 25 项双语 Web 验收中 24 项通过、1 项失败、0 项阻塞。WA-23 检查频道删除确认时，chrome-devtools evaluate_script 的默认 dialog action 在显式 handle_dialog dismiss 前接受了确认，导致临时频道 fixture 被删除（已恢复），违反了验收明确排除永久删除的边界。仅修正验收操作顺序或改用不会接受确认的观察方式，安全重跑 WA-23 并更新报告证据；不修改生产代码，不执行任何删除写请求。

## bugfix-02 · 授权页安全说明纳入唯一翻译目录

- 关联 task: task-21
- 描述: Review F001，位置 src/views/authorizations.ejs:35。三条安全说明正文与“已配置”免责声明使用 language 分支硬编码中英文，绕过 src/i18n.ts 唯一翻译事实源和目录扫描。将固定文案拆为扁平翻译键，EJS 只调用 t()；链接保持模板结构，不将 HTML 放入翻译值。

## bugfix-03 · 恢复频道检查间隔的单位与来源

- 关联 task: task-22
- 描述: Review F002，位置 src/public/channels.js:80。频道卡片错用表单键 channels.interval，并且只显示数字，丢失“分钟”单位以及“全局/频道覆盖”来源。标签改用 channels.checkInterval，按 checkIntervalMinutes === null 选择固定翻译键并恢复单位和来源，保持数值本地化与表单契约不变。

## bugfix-04 · 恢复频道详情代理选项语义

- 关联 task: task-23
- 描述: Review F003，位置 src/views/channel-detail.ejs:24。批量下载代理下拉将 value=channel 显示为通用 field.channel（“频道/Channel”），丢失“沿用频道代理 / Use channel proxy”的策略语义。新增并使用专用固定翻译键，保持 value=channel 和提交契约不变。

## bugfix-05 · 清理模板中绕过翻译目录的文案

- 关联 task: task-24
- 描述: Review F004，位置 src/views/channels.ejs:26，同类位置还包括 downloads.ejs 与 settings.ejs。频道 URL 帮助、同平台授权说明、首次同步 historyMonths 选项、下载平台地址规则和代理主机/端口 placeholder 使用 language 三元或分支硬编码中英文。为这些已确认文案补齐 zh-CN/en 固定键并统一调用 t()；含 HTML 的说明拆为安全结构，不改变业务行为。
