#!/usr/bin/env bash
# scripts/boundary-check.sh
set -euo pipefail
FAIL=0

echo "=== Module Boundary Check ==="

# Student app must not import AI or DB
grep -r "@ai-smartbook/ai" apps/AI-Stu-R1/ 2>/dev/null && echo "❌ FAIL: AI-Stu-R1 imports ai" && FAIL=1
grep -r "@ai-smartbook/db" apps/AI-Stu-R1/ 2>/dev/null && echo "❌ FAIL: AI-Stu-R1 imports db" && FAIL=1

# Student runtime must not import AI
grep -r "@ai-smartbook/ai" packages/student-runtime/ 2>/dev/null && echo "❌ FAIL: student-runtime imports ai" && FAIL=1

# book-core should not import AI or DB (after fix)
grep -r "@ai-smartbook/ai" packages/book-core/package.json 2>/dev/null && echo "⚠️  WARN: book-core depends on ai" && FAIL=1
grep -r "@ai-smartbook/db" packages/book-core/package.json 2>/dev/null && echo "⚠️  WARN: book-core depends on db" && FAIL=1

# No API keys in student deployment
grep -rI "API_KEY" deploy/systemd/student.env.example 2>/dev/null && echo "❌ FAIL: student.env has API_KEY" && FAIL=1

# No forbidden tech
grep -rIE "\b(mysql|MySQL|docker|Docker|PM2|pm2|redis|Redis)\b" apps/ packages/ 2>/dev/null && echo "❌ FAIL: forbidden tech reference found" && FAIL=1

[ $FAIL -eq 0 ] && echo "✅ All boundary checks passed" || echo "❌ Boundary violations detected"
exit $FAIL
