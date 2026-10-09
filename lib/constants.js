/**
 * dsh-ralph 常量定义。
 *
 * 这些值来自原版 Ralph（https://github.com/snarktank/ralph）的 ralph.sh 与
 * prompt.md，改造为 DSH 插件后保持不变，以保证 PRD 与提示词可以原样迁移。
 */

/** 子 agent 输出中出现该标记即认为全部用户故事已完成。 */
export const COMPLETE_MARKER = '<promise>COMPLETE</promise>'

/** 默认最大迭代轮数，与原版 ralph.sh 的 MAX_ITERATIONS 默认值一致。 */
export const DEFAULT_MAX_ITERATIONS = 10

/** 进程内一次性子 agent 的默认提供方名称（对应 @deepseek-ai/dsh-subagent-spawn-in-process）。 */
export const DEFAULT_PROVIDER = 'spawn'

/** 子 agent 正常结束的停止原因。 */
export const STOP_REASON_COMPLETED = 'completed'

/** 调用方取消导致的停止原因。 */
export const STOP_REASON_ABORTED = 'aborted'

/** 插件名，同时用作日志前缀。 */
export const PLUGIN_ID = 'dsh-ralph'

/** 工具与命令的默认名称。 */
export const DEFAULT_TOOL_NAME = 'ralph'
export const DEFAULT_COMMAND_NAME = 'ralph'

/** 默认文件名（相对于会话工作目录）。 */
export const DEFAULT_PRD_FILE = 'prd.json'
export const DEFAULT_PROGRESS_FILE = 'progress.txt'
export const DEFAULT_ARCHIVE_DIR = 'archive'
export const DEFAULT_LAST_BRANCH_FILE = '.last-branch'

/** 循环终止状态。 */
export const LOOP_STATUS = {
  /** 子 agent 报告全部故事已完成。 */
  COMPLETE: 'complete',
  /** 达到最大迭代轮数仍未完成。 */
  MAX_ITERATIONS: 'max-iterations',
  /** 调用方取消。 */
  ABORTED: 'aborted',
  /** 每轮都失败，循环无法推进。 */
  ERROR: 'error',
  /** 已有同会话的循环在运行。 */
  BUSY: 'busy',
  /** 前置条件不满足（例如 prd.json 缺失或为空）。 */
  PRECONDITION_FAILED: 'precondition-failed',
}
