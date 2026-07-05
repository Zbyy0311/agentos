# Delivery Standard

Every completed feature must include:

## Checklist

- [ ] Code — Implementation files
- [ ] Log — Agent execution log updated
- [ ] Git Diff — Changes shown via git diff
- [ ] Review — OpenCode review completed
- [ ] Risk — Risk assessment documented
- [ ] Todo — Next steps documented
- [ ] Test — Test results documented
- [ ] Memory — `agent-memory/` files updated (LOG.md, TASKS.md, etc.)

## Process

1. **Code** — Write implementation code
2. **Log** — Append to `agent-memory/LOG.md` with timestamp
3. **Diff** — Capture git diff before/after
4. **Review** — Run OpenCode review stage
5. **Risk** — Document any risks found
6. **Todo** — List remaining work items
7. **Test** — Run tests and document results
8. **Memory** — Update all relevant memory files

## Validation

- Pipeline must complete all 4 stages
- All stages must exit with code 0
- Logs must be written per stage
- Git diff must be available
