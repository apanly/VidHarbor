## bugfix-01 · 安全重跑删除确认的 Web 验收

- 关联 task: task-20
- 描述: task-19 的 25 项双语 Web 验收中 24 项通过、1 项失败、0 项阻塞。WA-23 检查频道删除确认时，chrome-devtools evaluate_script 的默认 dialog action 在显式 handle_dialog dismiss 前接受了确认，导致临时频道 fixture 被删除（已恢复），违反了验收明确排除永久删除的边界。仅修正验收操作顺序或改用不会接受确认的观察方式，安全重跑 WA-23 并更新报告证据；不修改生产代码，不执行任何删除写请求。
