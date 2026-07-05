# Security Guidelines

## CLI Execution

- All CLI commands are hardcoded in agent-core, not user-supplied
- No arbitrary command execution from user input
- Task titles are sanitized before storage
- CLI args are fixed arrays, not concatenated strings

## Path Safety

- All file paths are restricted to the project directory
- Path traversal (../) is not possible via user input
- File operations use absolute paths from PROJECT_ROOT

## Data Safety

- Agent memory files are append-only via the system
- No user data is executed or evaluated
- Git diff only shows changes, does not apply them

## Known Risks

- Mock mode: when CLI is missing, mock output is used
- Timeout: long-running CLI calls block the event loop
- Error: CLI failures surface error messages to the user

## Fallback Behavior

- If CLI binary is not found, MockCLI is used automatically
- Mock output is clearly distinguishable from real output
- User is not blocked from testing when CLI is unavailable
