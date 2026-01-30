--[[
  Atomic idempotent save operation with userId verification.

  Ensures that:
  1. Session exists
  2. User has access (if userId verification enabled)
  3. Session is not already saved (idempotency)
  4. Atomically marks as saved

  KEYS[1] = session key
  ARGV[1] = factId to record
  ARGV[2] = userId for verification (empty string to skip)
  ARGV[3] = TTL in seconds
  ARGV[4] = current timestamp (ms)

  Returns JSON:
  - { error: "not_found" } if session not found
  - { error: "unauthorized" } if userId mismatch
  - { alreadySaved: true, existingFactId: "..." } if already saved
  - { success: true } on successful save
]]

local key = KEYS[1]
local factId = ARGV[1]
local userId = ARGV[2]
local ttl = tonumber(ARGV[3])
local now = tonumber(ARGV[4])

local data = redis.call('GET', key)
if not data then
  return cjson.encode({ error = 'not_found' })
end

local session = cjson.decode(data)

-- Verify userId if provided and session has userId
if userId ~= '' and session.userId and session.userId ~= userId then
  return cjson.encode({ error = 'unauthorized' })
end

-- Check if already saved (idempotency)
if session.savedAt then
  return cjson.encode({
    alreadySaved = true,
    existingFactId = session.savedFactId
  })
end

-- Mark as saved
session.savedAt = now
session.savedFactId = factId

-- Save with refreshed TTL
redis.call('SETEX', key, ttl, cjson.encode(session))

return cjson.encode({ success = true })
