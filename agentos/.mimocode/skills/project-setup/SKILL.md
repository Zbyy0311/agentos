---
name: project-setup
description: Set up new project structure with backend, frontend, database, and configuration
---

# Project Setup Skill

## Purpose
Standardize the process of setting up new projects with proper structure, dependencies, and configuration. This skill captures the repeated pattern of project initialization observed across multiple sessions.

## When to Use
- User wants to create a new project from scratch
- User says "搭建项目结构", "创建项目", or "初始化项目"
- User needs a complete project setup with backend, frontend, and database

## Workflow

### Phase 1: Planning
1. **Gather requirements**
   - Project name and purpose
   - Tech stack preferences (Node.js, Python, etc.)
   - Database choice (SQLite for dev, PostgreSQL for prod)
   - Frontend framework (React, Vue, etc.)

2. **Define structure**
   ```
   project-name/
   ├── src/
   │   ├── api/           # API routes/endpoints
   │   ├── lib/           # Shared libraries
   │   ├── models/        # Data models
   │   └── utils/         # Utility functions
   ├── tests/             # Test files
   ├── docs/              # Documentation
   ├── config/            # Configuration files
   └── scripts/           # Build/deploy scripts
   ```

### Phase 2: Initialization
1. **Create project directory**
   ```bash
   mkdir project-name
   cd project-name
   ```

2. **Initialize package manager**
   ```bash
   # For Node.js projects
   npm init -y
   # or
   pnpm init
   
   # For Python projects
   python -m venv venv
   ```

3. **Install dependencies**
   ```bash
   # Core dependencies
   npm install express cors dotenv
   
   # Dev dependencies
   npm install -D typescript @types/node ts-node nodemon
   ```

### Phase 3: Structure Setup
1. **Create directory structure**
   ```bash
   mkdir -p src/{api,lib,models,utils}
   mkdir -p tests
   mkdir -p docs
   mkdir -p config
   ```

2. **Set up configuration files**
   - `.env` - Environment variables
   - `tsconfig.json` - TypeScript config (if using TS)
   - `.gitignore` - Git ignore rules
   - `README.md` - Project documentation

3. **Create base files**
   - `src/index.ts` - Entry point
   - `src/config/index.ts` - Configuration loader
   - `src/lib/prisma.ts` - Database client (if using Prisma)
   - `src/utils/api-response.ts` - API response helpers

### Phase 4: Database Setup
1. **Initialize database**
   ```bash
   # For Prisma
   npx prisma init
   # Edit schema.prisma for SQLite/PostgreSQL
   
   # Run migrations
   npx prisma migrate dev
   ```

2. **Create models**
   - Define data schema
   - Set up relations
   - Add indexes

### Phase 5: API Setup
1. **Create API routes**
   - Health check endpoint
   - Authentication routes
   - CRUD operations for main entities

2. **Set up middleware**
   - CORS configuration
   - Error handling
   - Authentication middleware

### Phase 6: Testing Setup
1. **Configure test framework**
   ```bash
   # For Jest
   npm install -D jest ts-jest @types/jest
   
   # For Vitest
   npm install -D vitest
   ```

2. **Create test files**
   - Unit tests for utilities
   - Integration tests for API endpoints
   - E2E tests for critical flows

## Output Format
- Use Chinese when user communicates in Chinese
- Provide step-by-step instructions
- Include code examples for each step
- Verify each step before moving to next

## Example Usage
User: "搭建一个Next.js项目结构"
Agent: Follow this skill to set up the project structure.

## Notes
- This skill is based on repeated patterns from sessions:
  - `ses_12c078d22ffesMs5dMxhSAv5xM` - child_teach project setup
  - `ses_13fbd993effeNwUvmpfTBs8ksX` - AI Camera project setup
  - `ses_147ee8e64ffei0M71DYUus5xpp` - Excel reader project setup
- For Windows environments, use PowerShell commands instead of bash
- Prefer SQLite for development, PostgreSQL for production
