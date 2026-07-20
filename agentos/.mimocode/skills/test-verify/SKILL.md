---
name: test-verify
description: Run tests, verify builds, and check project status systematically
---

# Test & Verify Skill

## Purpose
Standardize the process of testing, verifying builds, and checking project status. This skill captures the repeated verification patterns observed across multiple sessions.

## When to Use
- User wants to verify if code works correctly
- User says "测试一下", "验证一下", or "检查项目"
- User wants to ensure build passes before deployment
- User asks "项目有没有问题"

## Workflow

### Phase 1: Pre-verification
1. **Check environment**
   - Verify Node.js/Python version
   - Check if dependencies are installed
   - Ensure database is running (if required)

2. **Clean previous state**
   ```bash
   # Remove build artifacts
   rm -rf dist/ build/ .next/
   
   # Clear node_modules if needed
   rm -rf node_modules
   npm install
   ```

### Phase 2: Build Verification
1. **Run build commands**
   ```bash
   # For TypeScript projects
   npx tsc --noEmit  # Type checking
   
   # For Next.js projects
   npm run build
   
   # For general projects
   npm run build
   ```

2. **Check for errors**
   - Review build output for warnings/errors
   - Fix any compilation issues
   - Verify no type errors

### Phase 3: Test Execution
1. **Run unit tests**
   ```bash
   # For Jest
   npm test
   
   # For Vitest
   npx vitest run
   
   # For specific test file
   npm test -- --testPathPattern=filename
   ```

2. **Run integration tests**
   ```bash
   # If separate integration tests
   npm run test:integration
   ```

3. **Check test coverage**
   ```bash
   npm test -- --coverage
   ```

### Phase 4: API Verification
1. **Start development server**
   ```bash
   npm run dev
   ```

2. **Test API endpoints**
   ```bash
   # Health check
   curl http://localhost:3000/api/health
   
   # Test specific endpoints
   curl -X POST http://localhost:3000/api/auth/login \
     -H "Content-Type: application/json" \
     -d '{"username":"test","password":"test"}'
   ```

3. **Verify responses**
   - Check status codes
   - Validate response format
   - Test error handling

### Phase 5: Frontend Verification
1. **Start frontend server**
   ```bash
   # For React/Vue
   npm run dev
   
   # For Next.js
   npm run dev
   ```

2. **Manual testing**
   - Open browser to localhost
   - Test critical user flows
   - Check console for errors

3. **Automated E2E tests** (if available)
   ```bash
   npm run test:e2e
   ```

### Phase 6: Status Report
1. **Compile results**
   ```
   ## Project Verification Report
   
   ### Build Status
   - ✅ TypeScript compilation: PASS
   - ✅ Build process: PASS
   
   ### Test Results
   - Unit tests: 15/15 PASS
   - Integration tests: 8/8 PASS
   - Coverage: 85%
   
   ### API Status
   - Health check: ✅ OK
   - Authentication: ✅ Working
   - CRUD operations: ✅ Working
   
   ### Frontend Status
   - Development server: ✅ Running
   - Console errors: 0
   - Critical flows: ✅ Working
   
   ### Issues Found
   - None
   
   ### Recommendations
   1. [If any improvements needed]
   ```

2. **Provide next steps**
   - If all checks pass: "项目状态良好，可以继续开发"
   - If issues found: List specific fixes needed

## Output Format
- Use Chinese when user communicates in Chinese
- Provide clear pass/fail status for each check
- Include specific commands used
- Summarize findings clearly

## Example Usage
User: "测试一下后端API是否正常工作"
Agent: Follow this skill to verify API functionality.

User: "检查项目有没有问题"
Agent: Follow this skill to perform comprehensive project verification.

## Notes
- This skill is based on repeated patterns from sessions:
  - `ses_12c078d22ffesMs5dMxhSAv5xM` - Backend API testing
  - Multiple tasks in `TASKS.md` showing verification patterns
  - `ses_0a9f64284ffeStA0GFjMoXEQxs` - AgentOS issue verification
- Always run type checking before build
- Check both backend and frontend if applicable
- Document any issues found with specific file paths and line numbers
