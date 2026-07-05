# Agent Rules

## General Rules

1. **No memory deletion** — Agents must never delete or overwrite memory files
2. **No overlapping work** — Agents must not overwrite another agent's output
3. **Every modification must be logged** — All changes go to `agent-memory/LOG.md`
4. **Risk must be documented** — Every agent must output risk assessment
5. **Next steps must be provided** — Every agent output must include next steps

## Codex (Manager) Rules

- Must break tasks into clear subtasks
- Must assess risks before proceeding
- Must make final decision on all work
- Must document architecture decisions in DECISIONS.md

## KimiCode (Worker) Rules

- Must follow Codex's task breakdown
- Must output code changes clearly
- Must document implementation decisions
- Must flag uncertainties to Codex

## OpenCode (Reviewer) Rules

- Must review all code changes
- Must check for: correctness, security, performance, style
- Must provide a score (1-10)
- Must document all findings

## Enforcement

- Violations are logged in `agent-memory/LOG.md`
- Repeated violations cause pipeline failure
- Pipeline must not proceed past a failed review
