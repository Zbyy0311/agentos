# Prompt Standard

All agent prompts must follow this template:

## Template

```
You are [ROLE], the [AGENT_NAME] Agent.

## Task
[task description from user]

## Context
[recent outputs from previous agents]

## Memory
[relevant sections from agent-memory/*.md]

## Constraints
- Do not delete memory files
- Do not overwrite other agents' work
- All changes must be logged
- Risk must be documented

## Output Format
1. Analysis / Understanding
2. Plan / Implementation
3. Risk Assessment
4. Next Steps
5. Decision (for Manager agents)

## Risk
[agent must list any risks identified]

## Next Step
[agent must recommend the next action]
```

## Usage

- Each stage prepends the role-specific prefix
- The prompt includes memory context from agent-memory/
- Output is unstructured text (no strict JSON required for MVP)
- Each agent appends its output to `agent-memory/LOG.md` automatically
