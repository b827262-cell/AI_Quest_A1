// Security test fixtures - upload error MIME/oversize test metadata.
// All filenames and content types are synthetic. No real files.
//
// The oversize cases hold 25 MiB buffers, so they are built on demand:
// importing this module must stay allocation-free. Use
// `getUploadErrorCases()` (memoised) or `createUploadErrorCases()` (fresh).

function buildUploadErrorCases() {
  return [
    {
      name: "svg_direct_upload",
      filename: "attack.svg",
      contentType: "image/svg+xml",
      bytes: Buffer.from("<svg><script>alert(1)</script></svg>", "utf8"),
      expectedStatus: 415
    },
    {
      name: "svg_masquerading_as_png",
      filename: "attack.png",
      contentType: "image/png",
      bytes: Buffer.from("<svg><script>alert(1)</script></svg>", "utf8"),
      expectedStatus: 415
    },
    {
      name: "pdf_with_script_extension",
      filename: "document.pdf",
      contentType: "application/pdf",
      bytes: Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>", "utf8"),
      expectedStatus: 415
    },
    {
      name: "html_upload",
      filename: "page.html",
      contentType: "text/html",
      bytes: Buffer.from("<html><body>test</body></html>", "utf8"),
      expectedStatus: 415
    },
    {
      name: "executable_upload",
      filename: "tool.exe",
      contentType: "application/x-msdownload",
      bytes: Buffer.from("MZ\x90\x00", "binary"),
      expectedStatus: 415
    },
    {
      name: "oversize_upload",
      filename: "big.pdf",
      contentType: "application/pdf",
      bytes: Buffer.alloc(25 * 1024 * 1024 + 1),
      expectedStatus: 413
    },
    {
      name: "exact_limit_upload",
      filename: "exact.pdf",
      contentType: "application/pdf",
      bytes: Buffer.alloc(25 * 1024 * 1024),
      expectedStatus: 201
    },
    {
      name: "missing_file",
      filename: null,
      contentType: null,
      bytes: null,
      expectedStatus: 400
    },
    {
      name: "malformed_multipart",
      filename: null,
      contentType: "multipart/form-data; boundary=broken",
      bytes: Buffer.from("not multipart", "utf8"),
      expectedStatus: 400
    }
  ];
}

let cachedCases = null;

/** Memoised accessor: the 25 MiB buffers are allocated on first use only. */
export function getUploadErrorCases() {
  if (!cachedCases) cachedCases = buildUploadErrorCases();
  return cachedCases;
}

/** Fresh copy for suites that mutate case objects. */
export function createUploadErrorCases() {
  return buildUploadErrorCases();
}

export const ACCEPTED_IMAGE_TYPES = [
  { filename: "logo.png", contentType: "image/png", bytes: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]) },
  { filename: "logo.jpg", contentType: "image/jpeg", bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) },
  { filename: "logo.webp", contentType: "image/webp", bytes: Buffer.from("RIFFxxxxWEBP", "ascii") }
];

export function isUploadRejected(caseItem) {
  return [400, 413, 415].includes(caseItem.expectedStatus);
}
