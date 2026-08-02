export const SESSION_BINDING_V2_LUA = `
local op = ARGV[1]
local ttl = tonumber(ARGV[2])
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)

local function read_binding()
  local raw = redis.call('GET', KEYS[1])
  if not raw then return nil end
  local ok, value = pcall(cjson.decode, raw)
  if not ok or value.version ~= 2 then return false end
  if value.state == 'migrating' and tonumber(value.migrationLeaseUntil or 0) <= now then
    value.state = 'stable'
    value.pendingProviderId = cjson.null
    value.pendingKeyId = cjson.null
    value.migrationLeaseToken = cjson.null
    value.migrationLeaseUntil = cjson.null
    value.migrationAttemptOutcomeId = cjson.null
    redis.call('SET', KEYS[1], cjson.encode(value), 'PX', ttl)
  end
  return value
end

local function nullable_number(value)
  local number = tonumber(value)
  if not number or number < 0 then return cjson.null end
  return number
end

local function persist(value)
  redis.call('SET', KEYS[1], cjson.encode(value), 'PX', ttl)
  redis.call('PEXPIRE', KEYS[2], ttl)
  if ARGV[3] == '1' then
    redis.call('SET', KEYS[3], tostring(value.providerId), 'PX', ttl)
    if value.keyId ~= cjson.null then redis.call('SET', KEYS[4], tostring(value.keyId), 'PX', ttl) else redis.call('DEL', KEYS[4]) end
  end
end

if op == 'create' then
  if redis.call('EXISTS', KEYS[1]) == 1 then return {'EXISTS'} end
  local value = {
    version=2, generation=1, state='stable', providerId=tonumber(ARGV[4]),
    keyId=nullable_number(ARGV[5]), effectivePriority=tonumber(ARGV[6]),
    bindingReason='initial', failedOverFromProviderId=cjson.null,
    failedOverFromPriority=cjson.null, failedOverAt=cjson.null, boundAt=now,
    lastSuccessAt=now, failbackCooldownUntil=cjson.null, pendingProviderId=cjson.null,
    pendingKeyId=cjson.null, migrationLeaseToken=cjson.null,
    migrationLeaseUntil=cjson.null, migrationAttemptOutcomeId=cjson.null,
    providerBoundFlags=cjson.decode(ARGV[7])
  }
  persist(value)
  return {'APPLIED', cjson.encode(value), now}
end

local value = read_binding()
if value == nil then return {'NOT_FOUND'} end
if value == false then return {'MALFORMED'} end

if op == 'get' then
  persist(value)
  return {'APPLIED', cjson.encode(value), now}
end

local expected = tonumber(ARGV[4])
if tonumber(value.generation) ~= expected then return {'STALE_GENERATION', cjson.encode(value)} end

if op == 'claim_route' then
  if value.state ~= 'stable' then return {'MIGRATING', cjson.encode(value)} end
  redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now)
  redis.call('ZADD', KEYS[2], now + tonumber(ARGV[6]), ARGV[5])
  persist(value)
  return {'APPLIED', cjson.encode(value), now + tonumber(ARGV[6])}
elseif op == 'renew_route' then
  redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now)
  if not redis.call('ZSCORE', KEYS[2], ARGV[5]) then return {'STALE_TOKEN', cjson.encode(value)} end
  redis.call('ZADD', KEYS[2], now + tonumber(ARGV[6]), ARGV[5])
  persist(value)
  return {'APPLIED', cjson.encode(value), now + tonumber(ARGV[6])}
elseif op == 'release_route' then
  redis.call('ZREM', KEYS[2], ARGV[5])
  persist(value)
  return {'APPLIED', cjson.encode(value)}
elseif op == 'commit_route' then
  if value.state ~= 'stable' then return {'MIGRATING', cjson.encode(value)} end
  local old_provider = tonumber(value.providerId)
  local old_priority = tonumber(value.effectivePriority)
  local new_provider = tonumber(ARGV[5])
  local reason = ARGV[8]
  value.generation = value.generation + 1
  value.providerId = new_provider
  value.keyId = nullable_number(ARGV[6])
  value.effectivePriority = tonumber(ARGV[7])
  value.bindingReason = reason
  value.boundAt = now
  value.lastSuccessAt = now
  if reason == 'failover' or reason == 'race_winner' then
    if value.failedOverFromProviderId == cjson.null then
      value.failedOverFromProviderId = old_provider
      value.failedOverFromPriority = old_priority
      value.failedOverAt = now
    end
  elseif reason == 'failback' then
    value.failedOverFromProviderId = cjson.null
    value.failedOverFromPriority = cjson.null
    value.failedOverAt = cjson.null
    value.failbackCooldownUntil = cjson.null
  end
  redis.call('DEL', KEYS[2])
  persist(value)
  return {'APPLIED', cjson.encode(value)}
elseif op == 'prepare_migration' then
  if value.state ~= 'stable' then return {'MIGRATING', cjson.encode(value)} end
  redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now)
  if tonumber(redis.call('ZCARD', KEYS[2])) > 0 then return {'SESSION_BUSY', cjson.encode(value)} end
  value.state = 'migrating'
  value.pendingProviderId = tonumber(ARGV[5])
  value.pendingKeyId = nullable_number(ARGV[6])
  value.migrationLeaseToken = ARGV[7]
  value.migrationLeaseUntil = now + tonumber(ARGV[8])
  value.migrationAttemptOutcomeId = ARGV[9]
  persist(value)
  return {'APPLIED', cjson.encode(value)}
elseif op == 'renew_migration' then
  if value.state ~= 'migrating' or value.migrationLeaseToken ~= ARGV[5] then return {'STALE_TOKEN', cjson.encode(value)} end
  value.migrationLeaseUntil = now + tonumber(ARGV[6])
  persist(value)
  return {'APPLIED', cjson.encode(value)}
elseif op == 'commit_migration' then
  if value.state ~= 'migrating' or value.migrationLeaseToken ~= ARGV[5] then return {'STALE_TOKEN', cjson.encode(value)} end
  value.generation = value.generation + 1
  value.state = 'stable'
  value.providerId = value.pendingProviderId
  value.keyId = value.pendingKeyId
  value.effectivePriority = tonumber(ARGV[6])
  value.bindingReason = 'failback'
  value.boundAt = now
  value.lastSuccessAt = now
  value.failedOverFromProviderId = cjson.null
  value.failedOverFromPriority = cjson.null
  value.failedOverAt = cjson.null
  value.failbackCooldownUntil = cjson.null
  value.pendingProviderId = cjson.null
  value.pendingKeyId = cjson.null
  value.migrationLeaseToken = cjson.null
  value.migrationLeaseUntil = cjson.null
  value.migrationAttemptOutcomeId = cjson.null
  persist(value)
  return {'APPLIED', cjson.encode(value)}
elseif op == 'abort_migration' then
  if value.state ~= 'migrating' or value.migrationLeaseToken ~= ARGV[5] then return {'STALE_TOKEN', cjson.encode(value)} end
  value.state = 'stable'
  if tonumber(ARGV[6]) > 0 then value.failbackCooldownUntil = now + tonumber(ARGV[6]) end
  value.pendingProviderId = cjson.null
  value.pendingKeyId = cjson.null
  value.migrationLeaseToken = cjson.null
  value.migrationLeaseUntil = cjson.null
  value.migrationAttemptOutcomeId = cjson.null
  persist(value)
  return {'APPLIED', cjson.encode(value)}
end
return {'INVALID_OPERATION'}
`;
