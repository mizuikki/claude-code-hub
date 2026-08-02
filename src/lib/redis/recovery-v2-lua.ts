export const RECOVERY_V2_LUA = `
local op = ARGV[1]
local state_key = KEYS[1]
local trials_key = KEYS[2]
local outcomes_key = KEYS[3]
local window_key = KEYS[4]

local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)

local function number_field(name, fallback)
  return tonumber(redis.call('HGET', state_key, name) or tostring(fallback))
end

local function string_field(name, fallback)
  return redis.call('HGET', state_key, name) or fallback
end

local function retention()
  return tonumber(ARGV[#ARGV]) or 86400000
end

local function touch()
  local ttl = retention()
  if ttl < 1000 then ttl = 1000 end
  redis.call('PEXPIRE', state_key, ttl)
  if redis.call('EXISTS', trials_key) == 1 then redis.call('PEXPIRE', trials_key, ttl) end
  if redis.call('EXISTS', outcomes_key) == 1 then redis.call('PEXPIRE', outcomes_key, ttl) end
  if redis.call('EXISTS', window_key) == 1 then redis.call('PEXPIRE', window_key, ttl) end
end

local function prune_trials()
  redis.call('ZREMRANGEBYSCORE', trials_key, '-inf', now)
  return redis.call('ZCARD', trials_key)
end

local function prune_outcomes(dedupe_ttl)
  redis.call('ZREMRANGEBYSCORE', outcomes_key, '-inf', now - dedupe_ttl)
end

local function prune_window(window_duration)
  local cutoff = now - window_duration
  local fields = redis.call('HKEYS', window_key)
  for _, field in ipairs(fields) do
    local bucket = tonumber(string.match(field, ':b(%d+):'))
    if bucket and bucket < cutoff then redis.call('HDEL', window_key, field) end
  end
end

local function open_scope(reason, open_duration)
  local epoch = number_field('epoch', 0) + 1
  redis.call('HSET', state_key,
    'health', 'open',
    'epoch', epoch,
    'last_failure_at', now,
    'opened_at', now,
    'open_until', now + open_duration,
    'next_probe_at', now + open_duration,
    'probe_token', '',
    'probe_until', 0,
    'half_open_success_count', 0,
    'recovery_stage_index', 0,
    'recovery_stage_started_at', 0,
    'closed_stable_at', 0,
    'last_change_at', now,
    'last_transition_reason', reason)
  redis.call('DEL', trials_key)
  redis.call('DEL', window_key)
  return epoch
end

local function window_prefix(epoch, stage, bucket)
  return 'e' .. epoch .. ':s' .. stage .. ':b' .. bucket .. ':'
end

local function aggregate_window(epoch, stage, window_duration)
  local cutoff = now - window_duration
  local result = {total = 0, success = 0, failure = 0, slow = 0, hard = 0}
  local prefix = 'e' .. epoch .. ':s' .. stage .. ':'
  local fields = redis.call('HKEYS', window_key)
  for _, field in ipairs(fields) do
    if string.sub(field, 1, string.len(prefix)) == prefix then
      local bucket = tonumber(string.match(field, ':b(%d+):'))
      if bucket and bucket >= cutoff then
        local metric = string.match(field, ':([^:]+)$')
        if result[metric] ~= nil then
          result[metric] = result[metric] + tonumber(redis.call('HGET', window_key, field) or '0')
        end
      end
    end
  end
  return result
end

local function settle(expected_epoch, attempt_id, disposition, duration_ms,
  window_duration, bucket_duration, slow_threshold, minimum_outcomes,
  maximum_failure_rate, maximum_slow_rate, failure_threshold,
  hard_failure_threshold, half_open_success_threshold, open_duration, dedupe_ttl)
  prune_outcomes(dedupe_ttl)
  if redis.call('ZSCORE', outcomes_key, attempt_id) then
    return {'DUPLICATE', number_field('epoch', 0), string_field('health', 'open')}
  end
  local epoch = number_field('epoch', -1)
  if epoch ~= expected_epoch then return {'STALE_EPOCH', epoch, string_field('health', 'open')} end
  redis.call('ZADD', outcomes_key, now, attempt_id)

  local health = string_field('health', 'open')
  if disposition == 'ignored' then
    touch()
    return {'APPLIED', epoch, health}
  end

  if disposition == 'success' and health == 'closed' then
    redis.call('HSET', state_key, 'failure_count', 0, 'consecutive_hard_failure_count', 0)
    touch()
    return {'APPLIED', epoch, health}
  end

  if health == 'open' or health == 'probing' then
    touch()
    return {'APPLIED', epoch, health}
  end

  if disposition == 'hard_failure' then
    redis.call('HINCRBY', state_key, 'failure_count', 1)
    local hard_count = redis.call('HINCRBY', state_key, 'consecutive_hard_failure_count', 1)
    epoch = open_scope('hard_failure', open_duration)
    touch()
    return {'APPLIED', epoch, 'open'}
  elseif disposition == 'transient_failure' then
    local failures = redis.call('HINCRBY', state_key, 'failure_count', 1)
    redis.call('HSET', state_key, 'consecutive_hard_failure_count', 0, 'last_failure_at', now)
    if health == 'closed' and failures >= failure_threshold then
      epoch = open_scope('failure_threshold', open_duration)
      touch()
      return {'APPLIED', epoch, 'open'}
    elseif health == 'half_open' then
      epoch = open_scope('half_open_failure', open_duration)
      touch()
      return {'APPLIED', epoch, 'open'}
    end
  else
    redis.call('HSET', state_key, 'consecutive_hard_failure_count', 0)
  end

  if health == 'half_open' and disposition == 'success' then
    local successes = redis.call('HINCRBY', state_key, 'half_open_success_count', 1)
    if successes >= half_open_success_threshold then
      redis.call('HSET', state_key,
        'health', 'recovering',
        'recovery_started_at', now,
        'recovery_stage_index', 0,
        'recovery_stage_started_at', now,
        'failure_count', 0,
        'consecutive_hard_failure_count', 0,
        'last_change_at', now)
      redis.call('DEL', window_key)
      health = 'recovering'
    end
    touch()
    return {'APPLIED', epoch, health}
  end

  if health == 'recovering' then
    prune_window(window_duration)
    local stage = number_field('recovery_stage_index', 0)
    local bucket = math.floor(now / bucket_duration) * bucket_duration
    local prefix = window_prefix(epoch, stage, bucket)
    redis.call('HINCRBY', window_key, prefix .. 'total', 1)
    if disposition == 'success' then
      redis.call('HINCRBY', window_key, prefix .. 'success', 1)
    else
      redis.call('HINCRBY', window_key, prefix .. 'failure', 1)
    end
    if slow_threshold > 0 and duration_ms >= slow_threshold then
      redis.call('HINCRBY', window_key, prefix .. 'slow', 1)
    end
    if disposition == 'hard_failure' then
      redis.call('HINCRBY', window_key, prefix .. 'hard', 1)
    end
    local counters = aggregate_window(epoch, stage, window_duration)
    if counters.total >= minimum_outcomes then
      if counters.hard > 0 or counters.failure / counters.total > maximum_failure_rate or
        counters.slow / counters.total > maximum_slow_rate then
        epoch = open_scope('recovery_window_failure', open_duration)
        touch()
        return {'APPLIED', epoch, 'open'}
      end
    end
  end
  touch()
  return {'APPLIED', epoch, health}
end

if op == 'initialize' then
  local initial_health = ARGV[2]
  if redis.call('EXISTS', state_key) == 1 then
    return {'EXISTS', number_field('epoch', 0), string_field('health', 'open')}
  end
  local open_duration = tonumber(ARGV[3])
  local next_due = 0
  local opened_at = 0
  local open_until = 0
  local stable_at = 0
  if initial_health == 'open' then
    opened_at = now
    open_until = now + open_duration
    next_due = open_until
  elseif initial_health == 'closed' then
    stable_at = now
  else
    return {'INVALID_STATE', 0, initial_health}
  end
  redis.call('HSET', state_key,
    'version', 2, 'scope_json', ARGV[5], 'health', initial_health, 'epoch', 1,
    'automation_paused', 0, 'paused_at', 0, 'paused_reason', '',
    'failure_count', 0, 'consecutive_hard_failure_count', 0,
    'last_failure_at', 0, 'opened_at', opened_at, 'open_until', open_until,
    'next_probe_at', next_due, 'probe_attempt_count', 0,
    'probe_token', '', 'probe_until', 0, 'half_open_success_count', 0,
    'recovery_started_at', 0, 'recovery_stage_index', 0,
    'recovery_stage_started_at', 0, 'closed_stable_at', stable_at,
    'last_probe_at', 0, 'last_probe_succeeded_at', 0, 'last_change_at', now)
  touch()
  return {'APPLIED', 1, initial_health}
end

if redis.call('EXISTS', state_key) == 0 then return {'NOT_FOUND', -1, 'unknown'} end

if op == 'get_state' then
  local window_duration = tonumber(ARGV[2])
  local dedupe_ttl = tonumber(ARGV[3])
  if string_field('health', 'open') == 'probing' and number_field('probe_until', 0) <= now then
    redis.call('HSET', state_key,
      'health', 'open',
      'probe_token', '',
      'probe_until', 0,
      'next_probe_at', now,
      'last_change_at', now)
  end
  local occupancy = prune_trials()
  prune_outcomes(dedupe_ttl)
  prune_window(window_duration)
  local values = redis.call('HGETALL', state_key)
  local result = {'APPLIED', occupancy, now}
  local counters = aggregate_window(
    number_field('epoch', 0),
    number_field('recovery_stage_index', 0),
    window_duration)
  table.insert(result, 'window_total')
  table.insert(result, counters.total)
  table.insert(result, 'window_success')
  table.insert(result, counters.success)
  table.insert(result, 'window_failure')
  table.insert(result, counters.failure)
  table.insert(result, 'window_slow')
  table.insert(result, counters.slow)
  table.insert(result, 'window_hard')
  table.insert(result, counters.hard)
  for _, value in ipairs(values) do table.insert(result, value) end
  touch()
  return result
end

if op == 'record_outcome' then
  return settle(tonumber(ARGV[2]), ARGV[3], ARGV[4], tonumber(ARGV[5]),
    tonumber(ARGV[6]), tonumber(ARGV[7]), tonumber(ARGV[8]), tonumber(ARGV[9]),
    tonumber(ARGV[10]), tonumber(ARGV[11]), tonumber(ARGV[12]), tonumber(ARGV[13]),
    tonumber(ARGV[14]), tonumber(ARGV[15]), tonumber(ARGV[16]))
end

if op == 'claim_passive' then
  local expected_epoch = tonumber(ARGV[2])
  local epoch = number_field('epoch', -1)
  if epoch ~= expected_epoch then return {'STALE_EPOCH', epoch, string_field('health', 'open')} end
  if number_field('automation_paused', 0) == 1 then return {'PAUSED', epoch, string_field('health', 'open')} end
  if string_field('health', 'open') ~= 'open' then return {'INVALID_STATE', epoch, string_field('health', 'open')} end
  if number_field('open_until', now) > now then return {'NOT_DUE', epoch, 'open'} end
  redis.call('HSET', state_key, 'health', 'half_open', 'half_open_success_count', 0, 'last_change_at', now)
  touch()
  return {'APPLIED', epoch, 'half_open'}
end

if op == 'claim_probe' then
  local expected_epoch = tonumber(ARGV[2])
  local token = ARGV[3]
  local lease_ms = tonumber(ARGV[4])
  local epoch = number_field('epoch', -1)
  if epoch ~= expected_epoch then return {'STALE_EPOCH', epoch, string_field('health', 'open')} end
  if number_field('automation_paused', 0) == 1 then return {'PAUSED', epoch, string_field('health', 'open')} end
  if string_field('health', 'open') == 'probing' and number_field('probe_until', 0) > now then
    return {'CAPACITY_EXHAUSTED', epoch, 'probing'}
  end
  if string_field('health', 'open') ~= 'open' and
    not (string_field('health', 'open') == 'probing' and number_field('probe_until', 0) <= now) then
    return {'INVALID_STATE', epoch, string_field('health', 'open')}
  end
  if number_field('next_probe_at', now) > now then return {'NOT_DUE', epoch, 'open'} end
  redis.call('HSET', state_key, 'health', 'probing', 'probe_token', token,
    'probe_until', now + lease_ms, 'last_probe_at', now, 'last_change_at', now)
  redis.call('HINCRBY', state_key, 'probe_attempt_count', 1)
  touch()
  return {'APPLIED', epoch, 'probing', token, now + lease_ms}
end

if op == 'complete_probe' then
  local expected_epoch = tonumber(ARGV[2])
  local token = ARGV[3]
  local succeeded = ARGV[4] == '1'
  local next_probe_delay = tonumber(ARGV[5])
  local open_duration = tonumber(ARGV[6])
  local epoch = number_field('epoch', -1)
  if epoch ~= expected_epoch then return {'STALE_EPOCH', epoch, string_field('health', 'open')} end
  if string_field('health', 'open') ~= 'probing' then return {'INVALID_STATE', epoch, string_field('health', 'open')} end
  if string_field('probe_token', '') ~= token then return {'STALE_TOKEN', epoch, 'probing'} end
  if number_field('probe_until', 0) <= now then return {'STALE_TOKEN', epoch, 'probing'} end
  if number_field('automation_paused', 0) == 1 then return {'PAUSED', epoch, 'probing'} end
  if succeeded then
    redis.call('HSET', state_key, 'health', 'half_open', 'probe_token', '', 'probe_until', 0,
      'last_probe_succeeded_at', now, 'half_open_success_count', 0, 'last_change_at', now)
    touch()
    return {'APPLIED', epoch, 'half_open'}
  end
  epoch = open_scope('probe_failure', open_duration)
  redis.call('HSET', state_key, 'next_probe_at', now + next_probe_delay)
  touch()
  return {'APPLIED', epoch, 'open'}
end

if op == 'claim_trial' then
  local expected_epoch = tonumber(ARGV[2])
  local attempt_id = ARGV[3]
  local request_id = ARGV[4]
  local token = ARGV[5]
  local lease_ms = tonumber(ARGV[6])
  local capacity = tonumber(ARGV[7])
  local epoch = number_field('epoch', -1)
  if epoch ~= expected_epoch then return {'STALE_EPOCH', epoch, string_field('health', 'open')} end
  if number_field('automation_paused', 0) == 1 then return {'PAUSED', epoch, string_field('health', 'open')} end
  if string_field('health', 'open') ~= 'half_open' then return {'INVALID_STATE', epoch, string_field('health', 'open')} end
  local occupancy = prune_trials()
  local prefix = attempt_id .. '|'
  local members = redis.call('ZRANGE', trials_key, 0, -1)
  for _, member in ipairs(members) do
    if string.sub(member, 1, string.len(prefix)) == prefix then
      return {'DUPLICATE', epoch, 'half_open', occupancy}
    end
  end
  if occupancy >= capacity then return {'CAPACITY_EXHAUSTED', epoch, 'half_open', occupancy} end
  local member = attempt_id .. '|' .. request_id .. '|' .. token
  redis.call('ZADD', trials_key, now + lease_ms, member)
  touch()
  return {'APPLIED', epoch, 'half_open', occupancy + 1, token, now + lease_ms}
end

if op == 'renew_trial' then
  local expected_epoch = tonumber(ARGV[2])
  local member = ARGV[3] .. '|' .. ARGV[4] .. '|' .. ARGV[5]
  local lease_ms = tonumber(ARGV[6])
  local epoch = number_field('epoch', -1)
  if epoch ~= expected_epoch then return {'STALE_EPOCH', epoch, string_field('health', 'open')} end
  prune_trials()
  if not redis.call('ZSCORE', trials_key, member) then return {'LEASE_NOT_FOUND', epoch, string_field('health', 'open')} end
  redis.call('ZADD', trials_key, now + lease_ms, member)
  touch()
  return {'APPLIED', epoch, string_field('health', 'open'), now + lease_ms}
end

if op == 'release_trial' then
  local expected_epoch = tonumber(ARGV[2])
  local member = ARGV[3] .. '|' .. ARGV[4] .. '|' .. ARGV[5]
  local epoch = number_field('epoch', -1)
  if epoch ~= expected_epoch then return {'STALE_EPOCH', epoch, string_field('health', 'open')} end
  prune_trials()
  local removed = redis.call('ZREM', trials_key, member)
  touch()
  if removed == 0 then return {'LEASE_NOT_FOUND', epoch, string_field('health', 'open')} end
  return {'APPLIED', epoch, string_field('health', 'open'), prune_trials()}
end

if op == 'complete_trial' then
  local expected_epoch = tonumber(ARGV[2])
  local member = ARGV[3] .. '|' .. ARGV[4] .. '|' .. ARGV[5]
  prune_trials()
  if not redis.call('ZSCORE', trials_key, member) then
    if redis.call('ZSCORE', outcomes_key, ARGV[3]) then
      return {'DUPLICATE', number_field('epoch', 0), string_field('health', 'open')}
    end
    return {'LEASE_NOT_FOUND', number_field('epoch', 0), string_field('health', 'open')}
  end
  redis.call('ZREM', trials_key, member)
  return settle(expected_epoch, ARGV[3], ARGV[6], tonumber(ARGV[7]),
    tonumber(ARGV[8]), tonumber(ARGV[9]), tonumber(ARGV[10]), tonumber(ARGV[11]),
    tonumber(ARGV[12]), tonumber(ARGV[13]), tonumber(ARGV[14]), tonumber(ARGV[15]),
    tonumber(ARGV[16]), tonumber(ARGV[17]), tonumber(ARGV[18]))
end

if op == 'validate_admission' then
  local expected_epoch = tonumber(ARGV[2])
  local expected_stage = tonumber(ARGV[3])
  local bucket = tonumber(ARGV[4])
  local ceiling = tonumber(ARGV[5])
  local epoch = number_field('epoch', -1)
  if epoch ~= expected_epoch then return {'STALE_EPOCH', epoch, string_field('health', 'open')} end
  if number_field('automation_paused', 0) == 1 then return {'PAUSED', epoch, string_field('health', 'open')} end
  if string_field('health', 'open') ~= 'recovering' or
    number_field('recovery_stage_index', -1) ~= expected_stage then
    return {'INVALID_STATE', epoch, string_field('health', 'open')}
  end
  if bucket >= ceiling then return {'BUCKET_REJECTED', epoch, 'recovering'} end
  touch()
  return {'APPLIED', epoch, 'recovering', expected_stage}
end

if op == 'advance_recovery' then
  local expected_epoch = tonumber(ARGV[2])
  local window_duration = tonumber(ARGV[3])
  local minimum_outcomes = tonumber(ARGV[4])
  local maximum_failure_rate = tonumber(ARGV[5])
  local maximum_slow_rate = tonumber(ARGV[6])
  local ramp_duration = tonumber(ARGV[7])
  local stable_duration = tonumber(ARGV[8])
  local open_duration = tonumber(ARGV[9])
  local epoch = number_field('epoch', -1)
  if epoch ~= expected_epoch then return {'STALE_EPOCH', epoch, string_field('health', 'open')} end
  if number_field('automation_paused', 0) == 1 then return {'PAUSED', epoch, string_field('health', 'open')} end
  if string_field('health', 'open') ~= 'recovering' then return {'INVALID_STATE', epoch, string_field('health', 'open')} end
  local stage = number_field('recovery_stage_index', 0)
  local weights = {20, 20, 20, 40}
  local minimum_duration = stable_duration
  if stage < 4 then minimum_duration = math.ceil(ramp_duration * weights[stage + 1] / 100) end
  if now - number_field('recovery_stage_started_at', now) < minimum_duration then
    return {'NOT_DUE', epoch, 'recovering', stage}
  end
  prune_window(window_duration)
  local counters = aggregate_window(epoch, stage, window_duration)
  if counters.total < minimum_outcomes then return {'INSUFFICIENT_SAMPLES', epoch, 'recovering', stage, counters.total} end
  if counters.hard > 0 or counters.failure / counters.total > maximum_failure_rate or
    counters.slow / counters.total > maximum_slow_rate then
    epoch = open_scope('recovery_stage_failure', open_duration)
    touch()
    return {'APPLIED', epoch, 'open'}
  end
  if stage == 4 then
    redis.call('HSET', state_key, 'health', 'closed', 'closed_stable_at', now,
      'failure_count', 0, 'consecutive_hard_failure_count', 0, 'last_change_at', now)
    redis.call('DEL', window_key)
    touch()
    return {'APPLIED', epoch, 'closed'}
  end
  redis.call('HSET', state_key, 'recovery_stage_index', stage + 1,
    'recovery_stage_started_at', now, 'last_change_at', now)
  redis.call('DEL', window_key)
  touch()
  return {'APPLIED', epoch, 'recovering', stage + 1}
end

if op == 'admin' then
  local action = ARGV[2]
  local expected_epoch = tonumber(ARGV[3])
  local reason = ARGV[4]
  local confirmation = ARGV[5]
  local open_duration = tonumber(ARGV[6])
  local epoch = number_field('epoch', -1)
  if epoch ~= expected_epoch then return {'STALE_EPOCH', epoch, string_field('health', 'open')} end
  local health = string_field('health', 'open')
  if action == 'pause' then
    redis.call('HSET', state_key, 'automation_paused', 1, 'paused_at', now,
      'paused_reason', reason, 'last_change_at', now)
  elseif action == 'resume' then
    epoch = epoch + 1
    if health ~= 'closed' then health = 'open' end
    redis.call('HSET', state_key, 'epoch', epoch, 'health', health,
      'automation_paused', 0, 'paused_at', 0, 'paused_reason', '',
      'open_until', now, 'next_probe_at', now, 'probe_token', '', 'probe_until', 0,
      'last_change_at', now)
    redis.call('DEL', trials_key)
    redis.call('DEL', window_key)
  elseif action == 'reset' then
    epoch = open_scope('administrative_reset:' .. reason, 0)
    health = 'open'
    redis.call('HSET', state_key, 'next_probe_at', now)
  elseif action == 'force_open' then
    epoch = open_scope('administrative_force_open:' .. reason, open_duration)
    health = 'open'
  elseif action == 'force_close' then
    if confirmation ~= 'FORCE_CLOSE' then return {'CONFIRMATION_REQUIRED', epoch, health} end
    epoch = epoch + 1
    health = 'closed'
    redis.call('HSET', state_key, 'epoch', epoch, 'health', health,
      'automation_paused', 0, 'paused_at', 0, 'paused_reason', '',
      'failure_count', 0, 'consecutive_hard_failure_count', 0,
      'probe_token', '', 'probe_until', 0, 'closed_stable_at', now, 'last_change_at', now)
    redis.call('DEL', trials_key)
    redis.call('DEL', window_key)
  else
    return {'INVALID_STATE', epoch, health}
  end
  touch()
  return {'APPLIED', epoch, health}
end

return {'INVALID_OPERATION', number_field('epoch', -1), string_field('health', 'open')}
`;
