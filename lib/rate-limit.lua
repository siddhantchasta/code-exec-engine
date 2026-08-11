local key = KEYS[1]
local max_tokens = tonumber(ARGV[1])
local window_ms = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local ttl_seconds = tonumber(ARGV[4])

local values = redis.call('HMGET', key, 'tokens', 'lastRefill')
local tokens = tonumber(values[1]) or max_tokens
local last_refill = tonumber(values[2]) or now
local elapsed = math.max(0, now - last_refill)

tokens = math.min(max_tokens, tokens + ((elapsed / window_ms) * max_tokens))
last_refill = now

local allowed = 0
local retry_after = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
else
  retry_after = math.max(1, math.ceil(((1 - tokens) / max_tokens) * (window_ms / 1000)))
end

redis.call('HSET', key, 'tokens', tostring(tokens), 'lastRefill', tostring(last_refill))
redis.call('EXPIRE', key, ttl_seconds)

return { allowed, tostring(tokens), retry_after }
