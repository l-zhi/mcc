// Agent 类型注册表（多 Agent Phase 2）。
// 每个类型 = 一段角色系统提示词 + 一个工具子集。父代理用 subagent_type 选择，
// whenToUse 会喂进 Agent 工具的描述里，供父模型判断何时用哪个。
// 对齐参考项目 builtInAgents：general-purpose 全能、explore 只读调研。
export type AgentDefinition = {
  agentType: string
  /** 选择提示：喂给父模型，帮它决定何时用这个类型 */
  whenToUse: string
  /** 角色系统提示词，贴在主系统提示词之后 */
  systemPrompt: string
  /** 允许的工具名单；undefined = 全部（仍受 Agent/TodoWrite 通用护栏约束） */
  tools?: string[]
}

const GENERAL_PURPOSE: AgentDefinition = {
  agentType: 'general-purpose',
  whenToUse:
    '复杂、开放式或多步的任务，需要用到多种工具（读文件、搜索，必要时改文件/跑命令）。不确定时选它。',
  systemPrompt:
    'You are a general-purpose subagent handling a delegated sub-task. Work autonomously with the tools available to complete the task in the user message. When finished, respond with a SINGLE final message that fully and clearly summarizes your findings or result — it is the only thing the calling agent receives.',
}

const EXPLORE: AgentDefinition = {
  agentType: 'explore',
  whenToUse:
    '只读地调研代码库：查某个符号/用法在哪、理解某模块怎么工作、梳理结构。不修改任何文件。',
  tools: ['Read', 'Grep', 'Glob', 'LSP'],
  systemPrompt:
    'You are a read-only exploration subagent. Investigate the codebase to answer the task using only the read tools available (Read/Grep/Glob/LSP) — you cannot modify anything. When done, respond with a SINGLE final message reporting what you found, with concrete file paths and line references where relevant — it is the only thing the calling agent receives.',
}

const REGISTRY: AgentDefinition[] = [GENERAL_PURPOSE, EXPLORE]

export const DEFAULT_AGENT_TYPE = GENERAL_PURPOSE.agentType

export function getAgentDefinitions(): AgentDefinition[] {
  return REGISTRY
}

export function getAgentDefinition(type: string): AgentDefinition | undefined {
  return REGISTRY.find(d => d.agentType === type)
}
