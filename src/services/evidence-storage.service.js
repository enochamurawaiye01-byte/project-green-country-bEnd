const { createClient } = require("@supabase/supabase-js");

class EvidenceStorageError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "EvidenceStorageError";
    this.code = code;
  }
}

async function getPrivateEvidenceStorage() {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_STORAGE_BUCKET } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !SUPABASE_STORAGE_BUCKET) {
    throw new EvidenceStorageError(
      "EVIDENCE_STORAGE_NOT_CONFIGURED",
      "Private evidence storage is not configured."
    );
  }
  let url;
  try {
    url = new URL(SUPABASE_URL);
  } catch {
    throw new EvidenceStorageError(
      "EVIDENCE_STORAGE_INVALID_CONFIGURATION",
      "Evidence storage configuration is invalid."
    );
  }
  if (url.protocol !== "https:" || !url.hostname.endsWith(".supabase.co")) {
    throw new EvidenceStorageError(
      "EVIDENCE_STORAGE_INVALID_CONFIGURATION",
      "Evidence storage configuration is invalid."
    );
  }

  const client = createClient(url.origin, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: bucket, error } = await client.storage.getBucket(SUPABASE_STORAGE_BUCKET);
  if (error || !bucket) {
    throw new EvidenceStorageError(
      "EVIDENCE_STORAGE_BUCKET_UNAVAILABLE",
      "The configured evidence storage bucket is unavailable."
    );
  }
  if (bucket.public !== false) {
    throw new EvidenceStorageError(
      "EVIDENCE_STORAGE_BUCKET_MUST_BE_PRIVATE",
      "Evidence uploads require a private storage bucket."
    );
  }
  return {
    bucketName: SUPABASE_STORAGE_BUCKET,
    storage: client.storage.from(SUPABASE_STORAGE_BUCKET),
  };
}

module.exports = { EvidenceStorageError, getPrivateEvidenceStorage };
