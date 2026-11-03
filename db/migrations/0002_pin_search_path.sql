-- Pin search_path on every function, so a role that can create objects in
-- another schema can't make these functions resolve to its own copies.
alter function hire.current_company_id() set search_path = hire, pg_temp;
alter function hire.current_actor() set search_path = hire, pg_temp;
alter function hire.touch_updated_at() set search_path = hire, pg_temp;
alter function hire.hit_rate_limit(text, integer) set search_path = hire, pg_temp;
