#!/usr/bin/env bash
# scripts/boundary-check.sh — browser/server module boundary gate.
#
# The rule being enforced: the student browser bundle (apps/AI-Stu-R1/src)
# may never import server-only packages (@ai-smartbook/ai, @ai-smartbook/db)
# or talk to an LLM provider directly. The student server/ directory is the
# only place allowed to reach the RAG/AI stack.
set -uo pipefail
FAIL=0

echo "=== Module Boundary Check ==="

# --- Browser boundary -------------------------------------------------------
# Student browser bundle must not import AI or DB packages.
if grep -rn --include='*.ts' --include='*.tsx' "@ai-smartbook/ai\|@ai-smartbook/db" apps/AI-Stu-R1/src/ 2>/dev/null; then
  echo "❌ FAIL: student browser bundle imports server-only packages"
  FAIL=1
fi

# Student browser bundle must not call any LLM provider directly.
if grep -rniE --include='*.ts' --include='*.tsx' "api\.cerebras|cerebras\.ai|openai\.com|generativelanguage" apps/AI-Stu-R1/src/ 2>/dev/null; then
  echo "❌ FAIL: student browser bundle references an LLM provider endpoint"
  FAIL=1
fi

# --- Package boundaries ------------------------------------------------------
# Student runtime must not import the AI orchestration package.
if grep -rn --include='*.ts' "@ai-smartbook/ai" packages/student-runtime/src/ 2>/dev/null; then
  echo "❌ FAIL: student-runtime imports ai"
  FAIL=1
fi

# Informational: book-core historically depends on ai/db. Tracked as a known
# limitation; it does not affect the browser/server split enforced above.
if grep -q "@ai-smartbook/ai" packages/book-core/package.json 2>/dev/null; then
  echo "⚠️  WARN: book-core depends on ai (known limitation)"
fi
if grep -q "@ai-smartbook/db" packages/book-core/package.json 2>/dev/null; then
  echo "⚠️  WARN: book-core depends on db (known limitation)"
fi

# --- Deployment hygiene -------------------------------------------------------
# No API keys shipped in the student deployment template.
if grep -rI "API_KEY" deploy/systemd/student.env.example 2>/dev/null; then
  echo "❌ FAIL: student.env has API_KEY"
  FAIL=1
fi

# Forbidden infrastructure tech in first-party sources (word-boundary match so
# words like "redistribute" cannot trigger the redis rule).
FORBIDDEN_SOURCES=$(find apps/*/src apps/*/server packages/*/src scripts -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.mjs' \) 2>/dev/null)
if echo "$FORBIDDEN_SOURCES" | xargs grep -rniEw 'mysql|docker|pm2|redis' 2>/dev/null; then
  echo "❌ FAIL: forbidden tech reference found"
  FAIL=1
fi

if [ $FAIL -eq 0 ]; then
  echo "✅ All boundary checks passed"
else
  echo "❌ Boundary violations detected"
fi
exit $FAIL
