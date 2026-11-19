-- OAuth access tokens record the resource (audience) they were issued for (RFC 8707).
ALTER TABLE api_tokens ADD COLUMN resource TEXT;
