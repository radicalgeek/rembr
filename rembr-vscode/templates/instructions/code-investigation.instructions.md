---
applyTo: "**"
description: Best practices for code investigation in RLM subtasks
---

# Code Investigation Guidelines

When investigating code as part of RLM or Ralph-RLM subtasks, follow these patterns.

## Search Tools

### Pattern Search with ripgrep
```bash
# Search for pattern in specific file types
rg "pattern" --type ts

# Search with context lines
rg "pattern" -C 3

# Search case-insensitive
rg -i "pattern"

# Search for whole words only
rg -w "functionName"

# Search excluding directories
rg "pattern" --glob '!node_modules' --glob '!dist'
```

### File Location with find
```bash
# Find files by name pattern
find . -name "*.config.ts"

# Find files in specific path
find src -name "*.test.ts"

# Find files modified recently
find . -mtime -1 -name "*.ts"
```

### Content Extraction
```bash
# Get specific line range
sed -n '10,50p' src/file.ts

# Get first N lines
head -n 20 src/file.ts

# Get last N lines  
tail -n 20 src/file.ts

# Get line with context
grep -n -B 2 -A 2 "pattern" src/file.ts
```

## Investigation Patterns

### Authentication Analysis
```bash
rg "password|secret|key|token" --type ts
rg "bcrypt|argon|hash|encrypt" --type ts
rg "session|cookie|jwt" --type ts
```

### API Endpoint Analysis
```bash
rg "router\.(get|post|put|delete)" --type ts
rg "@(Get|Post|Put|Delete)" --type ts
rg "app\.(get|post|put|delete)" --type js
```

### Security Analysis
```bash
rg "sanitize|validate|escape" --type ts
rg "eval\(|exec\(|spawn\(" --type ts
rg "innerHTML|dangerouslySetInnerHTML" --type tsx
```

### Dependency Analysis
```bash
rg "import .* from" --type ts | sort | uniq
rg "require\(" --type js
cat package.json | jq '.dependencies'
```

## Evidence Format

Always cite findings with exact location:

```
Found: bcrypt with cost factor 10
Location: src/auth/password.ts:42
Evidence: `const hash = await bcrypt.hash(password, 10)`
```

## Validation Before Storing

Before storing a finding in Rembr:
1. ✅ Have specific file:line reference
2. ✅ Content is verified (not assumed)
3. ✅ Relates to a specific subtask or criterion
4. ✅ Can be independently verified
