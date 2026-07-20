---
name: code-review
description: Perform structured code review with bug detection, quality analysis, and improvement suggestions
---

# Code Review Skill

## Purpose
Perform systematic code review to identify bugs, quality issues, and improvement opportunities. This skill standardizes the code review workflow observed across multiple sessions.

## When to Use
- User asks to "review code", "check for bugs", "find issues", or "suggest improvements"
- User wants a comprehensive analysis before making changes
- User says "看一下代码" or "看看有没有bug"

## Workflow

### Phase 1: Discovery
1. **Identify project structure**
   - Read project root files (package.json, README, etc.)
   - Map directory structure
   - Identify tech stack and frameworks

2. **Locate source code**
   - Find main source directories
   - Identify entry points
   - Map module dependencies

### Phase 2: Analysis
1. **Code Quality Review**
   - Check for dead code, unused imports, redundant logic
   - Identify code smells (long functions, deep nesting, duplicated code)
   - Review naming conventions and consistency

2. **Bug Detection**
   - Look for edge cases and error handling gaps
   - Check for race conditions, memory leaks, null pointer issues
   - Identify potential runtime errors

3. **Architecture Review**
   - Evaluate module separation and coupling
   - Check for proper abstraction levels
   - Review dependency management

4. **Performance Review**
   - Identify inefficient algorithms or data structures
   - Check for unnecessary computations
   - Review resource usage (memory, CPU, I/O)

### Phase 3: Reporting
1. **Categorize findings**
   - 🔴 Critical: Bugs that will cause errors or data loss
   - 🟡 Warning: Potential issues or bad practices
   - 🔵 Improvement: Optimization or quality suggestions
   - ⚪ Info: Observations or notes

2. **Provide actionable recommendations**
   - For each finding, explain the issue
   - Suggest specific fixes with code examples
   - Prioritize by severity and impact

3. **Structure the report**
   ```
   ## Code Review Summary
   
   ### Critical Issues
   - [Issue 1]: [Description] → [Fix suggestion]
   
   ### Warnings
   - [Issue 2]: [Description] → [Fix suggestion]
   
   ### Improvements
   - [Issue 3]: [Description] → [Fix suggestion]
   
   ### Architecture Notes
   - [Observation]
   
   ### Next Steps
   1. [Priority 1 action]
   2. [Priority 2 action]
   ```

## Output Format
- Use Chinese when user communicates in Chinese
- Be specific with file paths and line numbers
- Provide code examples for fixes
- Prioritize findings by severity

## Example Usage
User: "看一下代码，看看有没有bug"
Agent: Follow this skill to perform structured code review.

## Notes
- This skill is based on repeated patterns from sessions:
  - `ses_0f1934e74ffe7HYG3DOPmaxbKl` - Subscription quota review
  - `ses_0a9f64270ffeYmgt1u1O76qgPk` - AgentOS code review
  - `ses_0a9f643dcffe4vyXYMiSrq6kCc` - Code optimization review
