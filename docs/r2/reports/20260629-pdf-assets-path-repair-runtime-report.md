# E500 Runtime Data & Assets Path Repair Report (2026-06-29)

This report logs the runtime environment fix performed on the E500 central instance to resolve PDF "file not found" errors under the Option A architecture.

## Incident Description
When requesting the PDF stream of certain books via the `pdf-view` student API, it responded with `{"error":"file not found"}`. 

Upon investigation:
* The SQLite database table `book_files` stored absolute paths pointing to non-existent directories from older workspaces: `/home/b827262/project/AI-SmartBook-R2/...` and `/home/b827262/project/AI-SmartBook-R1/...`.
* The physical PDF asset files were missing in the active `AI-SmartBook-R1-PR4/uploads/` workspace.

## Repair Steps

### 1. Database Backup
Before performing any modification, the SQLite database was backed up:
```bash
cp data/ai-smartbook-r1.db data/ai-smartbook-r1.db.bak.$(date +%Y%m%d%H%M%S)
```

### 2. Assets Synchronization
The physical assets (PDF documents, JSON indices, reader outlines, and appearance images) were restored from backups using `rsync`:
* **R2 Assets Restoration**: 
  * Sync source `/home/b827262/project/_backup/AI-SmartBook-R2/apps/AI-adm-D1/uploads/books/` to `/home/b827262/project/AI-SmartBook-R1-PR4/uploads/books/`
  * Sync source `/home/b827262/project/_backup/AI-SmartBook-R2/apps/AI-adm-D1/uploads/appearance/` to `/home/b827262/project/AI-SmartBook-R1-PR4/uploads/appearance/`
* **R1 Assets Restoration**:
  * Sync source `/home/b827262/project/_backup/Fire it Stop/AI-SmartBook-R1/apps/AI-adm-D1/uploads/books/` to `/home/b827262/project/AI-SmartBook-R1-PR4/uploads/books/`

### 3. Database Path Correction
We identified and replaced invalid path prefixes in `book_files` table:
* **R2 Path Prefix Replacement**:
  * **Old Prefix**: `/home/b827262/project/AI-SmartBook-R2/apps/AI-adm-D1/uploads/books`
  * **New Prefix**: `/home/b827262/project/AI-SmartBook-R1-PR4/uploads/books`
  * **Rows Affected**: 6
* **R1 Path Prefix Replacement**:
  * **Old Prefix**: `/home/b827262/project/AI-SmartBook-R1/apps/AI-adm-D1/uploads/books`
  * **New Prefix**: `/home/b827262/project/AI-SmartBook-R1-PR4/uploads/books`
  * **Rows Affected**: 7

SQL statements executed:
```sql
UPDATE book_files
SET file_path = REPLACE(
  file_path,
  '/home/b827262/project/AI-SmartBook-R2/apps/AI-adm-D1/uploads/books',
  '/home/b827262/project/AI-SmartBook-R1-PR4/uploads/books'
)
WHERE file_path LIKE '/home/b827262/project/AI-SmartBook-R2/apps/AI-adm-D1/uploads/books%';

UPDATE book_files
SET file_path = REPLACE(
  file_path,
  '/home/b827262/project/AI-SmartBook-R1/apps/AI-adm-D1/uploads/books',
  '/home/b827262/project/AI-SmartBook-R1-PR4/uploads/books'
)
WHERE file_path LIKE '/home/b827262/project/AI-SmartBook-R1/apps/AI-adm-D1/uploads/books%';
```

---

## Post-Repair Health Check & Validation

### 1. Database Prefix Integrity Check
Verified that no invalid prefixes remain:
```sql
SELECT COUNT(*) FROM book_files WHERE file_path LIKE '%AI-SmartBook-R2%';
-- Result: 0

SELECT COUNT(*) FROM book_files WHERE file_path LIKE '%/AI-SmartBook-R1/%';
-- Result: 0
```

### 2. Physical File Integrity Check
Verified that all PDF paths recorded in the database exist on the host filesystem:
```bash
sqlite3 -noheader -separator '|' data/ai-smartbook-r1.db "
SELECT id, file_path
FROM book_files
WHERE file_type='application/pdf' OR file_name LIKE '%.pdf';
" | while IFS='|' read -r id path; do
  if [ ! -f "$path" ]; then
    echo "MISSING $id $path"
  fi
done
```
* **Result**: **No missing files detected.** All PDF documents exist on disk.

### 3. API Response Verification (Smoke Test)
* **Target Book**: `book_217a190a-3678-4959-97b4-6e3580b3fae3`
* **Target PDF File**: `file_0e628dea-a451-44c7-891f-2880ea5b766f`

Requested student session and stream of `file_0e628dea-a451-44c7-891f-2880ea5b766f`:
```bash
curl -I -H "X-Student-Session-Id: $SESSION_ID" http://100.76.46.86:4300/api/student/books/$BOOK_ID/files/$FILE_ID/pdf-view
```

**Output**:
```http
HTTP/1.1 200 OK
X-Powered-By: Express
Content-Type: application/pdf
Content-Disposition: inline; filename="reader.pdf"
Cache-Control: private, no-store, no-cache, must-revalidate
```

The PDF file stream now functions correctly.

## Final Browser Verification
- Browser URL: `http://34.81.110.125/books/book_217a190a-3678-4959-97b4-6e3580b3fae3`
- Result: `PASS` — Desktop and mobile browser can open the book and PDF renders normally.

## Final Status
- PDF 404 / PDF loading / mobile PDF display fixed.
