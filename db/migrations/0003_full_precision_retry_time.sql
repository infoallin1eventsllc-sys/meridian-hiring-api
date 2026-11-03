-- next_attempt_at was rounded to milliseconds, which can round *up*: a delivery
-- queued at 12:00:00.1236 was stored as .124 and was not yet "due" for an
-- immediate send in the same millisecond. Keep full precision for scheduling.
-- (Columns used for cursor paging stay at millisecond precision on purpose.)
alter table hire.webhook_deliveries alter column next_attempt_at type timestamptz;
