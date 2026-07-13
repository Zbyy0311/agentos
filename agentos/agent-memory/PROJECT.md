# agentos

Project memory initialized.

## Skills

The following skills have been created to standardize repeated workflows:

### 1. Code Review Skill (`code-review`)
- **Purpose**: Perform structured code review with bug detection, quality analysis, and improvement suggestions
- **When to use**: User asks to "review code", "check for bugs", "find issues", or "suggest improvements"
- **Location**: `.mimocode/skills/code-review/SKILL.md`

### 2. Project Setup Skill (`project-setup`)
- **Purpose**: Set up new project structure with backend, frontend, database, and configuration
- **When to use**: User wants to create a new project from scratch
- **Location**: `.mimocode/skills/project-setup/SKILL.md`

### 3. Test & Verify Skill (`test-verify`)
- **Purpose**: Run tests, verify builds, and check project status systematically
- **When to use**: User wants to verify if code works correctly
- **Location**: `.mimocode/skills/test-verify/SKILL.md`

## Development Notes

- Project uses TypeScript with monorepo structure
- Backend: Express/Fastify with Prisma ORM
- Frontend: React/Next.js
- Testing: Vitest/Jest
- Database: SQLite (dev), PostgreSQL (prod)
