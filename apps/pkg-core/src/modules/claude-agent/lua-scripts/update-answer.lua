--[[
  Atomic update of recall session answer with userId verification.

  KEYS[1] = session key
  ARGV[1] = new answer
  ARGV[2] = new sources (JSON string, empty string to skip)
  ARGV[3] = userId for verification (empty string to skip)
  ARGV[4] = TTL in seconds

  Returns:
  - nil if session not found
  - JSON { error: "unauthorized" } if userId mismatch
  - JSON session object on success
]]

local key = KEYS[1]
local newAnswer = ARGV[1]
local newSources = ARGV[2]
local userId = ARGV[3]
local ttl = tonumber(ARGV[4])

local data = redis.call('GET', key)
if not data then
  return nil
end

local session = cjson.decode(data)

-- Verify userId if provided and session has userId
if userId ~= '' and session.userId and session.userId ~= userId then
  return cjson.encode({ error = 'unauthorized' })
end

-- Update answer
session.answer = newAnswer

-- Update sources if provided
if newSources ~= '' then
  session.sources = cjson.decode(newSources)
end

-- Save with refreshed TTL
redis.call('SETEX', key, ttl, cjson.encode(session))

return cjson.encode(session)
