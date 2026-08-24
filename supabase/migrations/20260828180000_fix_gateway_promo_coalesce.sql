-- Repair the two promo-aware gateway functions without rewriting the applied
-- 20260828140000 migration. COALESCE is SQL expression syntax, not a callable
-- pg_catalog function; schema-qualifying it makes every reservation fail before
-- dispatch with undefined_function.
--
-- IDEMPOTENT REPAIR: a function that already carries no broken form is skipped
-- with a notice instead of raising. The strict "expected broken COALESCE"
-- precondition assumed this migration is the only writer of these bodies, but
-- an environment can legitimately reach it already clean — prod was repaired
-- by hot-applied statements before this migration was recorded there, so the
-- next prod migrate would find bare COALESCE and abort the whole deploy on
-- the old raise. Only a genuinely absent function still raises — that is a
-- broken chain, not a clean one. Later migrations (20260828210000, and
-- 20260828220000 for settle) re-create these bodies wholesale afterward, so
-- skipping here never leaves a broken form behind on any ordered replay.

do $$
declare
  v_definition pg_catalog.text;
  v_source pg_catalog.text;
  v_executable_definition pg_catalog.text;
  v_oid pg_catalog.oid;
  v_signature pg_catalog.text;
  v_char pg_catalog.text;
  v_next_char pg_catalog.text;
  v_dollar_delimiter pg_catalog.text;
  v_dollar_match pg_catalog.text[];
  v_pos integer;
  v_length integer;
  v_close_offset integer;
  v_comment_depth integer;
  v_pass integer;
begin
  foreach v_signature in array array[
    'public.gateway_start_attempt(text,uuid,integer,integer,text,text,text,text,text,text,text,timestamp with time zone,bigint,bigint,bigint,bigint,bigint)',
    'public.gateway_settle_attempt(text,text,text,integer,integer,integer,integer,text,boolean,text[],text)'
  ] loop
    v_oid := pg_catalog.to_regprocedure(v_signature);
    if v_oid is null then
      raise exception 'required gateway function is absent: %', v_signature;
    end if;

    v_definition := pg_catalog.pg_get_functiondef(v_oid);
    -- Scan the function source instead of using independent regular
    -- expressions. PostgreSQL permits nested block comments, dollar-quoted
    -- strings, and E'...' strings with backslash escapes; stripping each
    -- lexical form prevents non-executable COALESCE text from satisfying the
    -- final guard.
    for v_pass in 1..2 loop
      select p.prosrc
        into v_source
        from pg_catalog.pg_proc as p
       where p.oid = v_oid;

      v_executable_definition := '';
      v_pos := 1;
      v_length := pg_catalog.char_length(v_source);
      while v_pos <= v_length loop
        v_char := pg_catalog.substr(v_source, v_pos, 1);
        v_next_char := pg_catalog.substr(v_source, v_pos + 1, 1);

        if v_char = '-' and v_next_char = '-' then
          v_executable_definition := v_executable_definition || ' ';
          v_pos := v_pos + 2;
          while v_pos <= v_length
            and pg_catalog.substr(v_source, v_pos, 1) <> E'\n'
          loop
            v_pos := v_pos + 1;
          end loop;
          continue;
        end if;

        if v_char = '/' and v_next_char = '*' then
          v_executable_definition := v_executable_definition || ' ';
          v_comment_depth := 1;
          v_pos := v_pos + 2;
          while v_pos <= v_length and v_comment_depth > 0 loop
            if pg_catalog.substr(v_source, v_pos, 2) = '/*' then
              v_comment_depth := v_comment_depth + 1;
              v_pos := v_pos + 2;
            elsif pg_catalog.substr(v_source, v_pos, 2) = '*/' then
              v_comment_depth := v_comment_depth - 1;
              v_pos := v_pos + 2;
            else
              v_pos := v_pos + 1;
            end if;
          end loop;
          continue;
        end if;

        if v_char = '$' then
          v_dollar_match := pg_catalog.regexp_match(
            pg_catalog.substr(v_source, v_pos),
            '^[$]([A-Za-z_][A-Za-z0-9_]*)?[$]'
          );
          if v_dollar_match is not null then
            v_dollar_delimiter := '$' || pg_catalog.coalesce(v_dollar_match[1], '') || '$';
            v_close_offset := pg_catalog.strpos(
              pg_catalog.substr(
                v_source,
                v_pos + pg_catalog.char_length(v_dollar_delimiter)
              ),
              v_dollar_delimiter
            );
            v_executable_definition := v_executable_definition || ' ';
            if v_close_offset = 0 then
              v_pos := v_length + 1;
            else
              v_pos := v_pos
                + (2 * pg_catalog.char_length(v_dollar_delimiter))
                + v_close_offset
                - 1;
            end if;
            continue;
          end if;
        end if;

        if v_char in ('E', 'e') and v_next_char = '''' then
          v_executable_definition := v_executable_definition || ' ';
          v_pos := v_pos + 2;
          while v_pos <= v_length loop
            v_char := pg_catalog.substr(v_source, v_pos, 1);
            v_next_char := pg_catalog.substr(v_source, v_pos + 1, 1);
            if v_char = E'\\' then
              v_pos := v_pos + 2;
            elsif v_char = '''' then
              if v_next_char = '''' then
                v_pos := v_pos + 2;
              else
                v_pos := v_pos + 1;
                exit;
              end if;
            else
              v_pos := v_pos + 1;
            end if;
          end loop;
          continue;
        end if;

        if v_char = '''' then
          v_executable_definition := v_executable_definition || ' ';
          v_pos := v_pos + 1;
          while v_pos <= v_length loop
            v_char := pg_catalog.substr(v_source, v_pos, 1);
            v_next_char := pg_catalog.substr(v_source, v_pos + 1, 1);
            if v_char = '''' then
              if v_next_char = '''' then
                v_pos := v_pos + 2;
              else
                v_pos := v_pos + 1;
                exit;
              end if;
            else
              v_pos := v_pos + 1;
            end if;
          end loop;
          continue;
        end if;

        if v_char = '"' then
          v_executable_definition := v_executable_definition || ' ';
          v_pos := v_pos + 1;
          while v_pos <= v_length loop
            v_char := pg_catalog.substr(v_source, v_pos, 1);
            v_next_char := pg_catalog.substr(v_source, v_pos + 1, 1);
            if v_char = '"' then
              if v_next_char = '"' then
                v_pos := v_pos + 2;
              else
                v_pos := v_pos + 1;
                exit;
              end if;
            else
              v_pos := v_pos + 1;
            end if;
          end loop;
          continue;
        end if;

        v_executable_definition := v_executable_definition || v_char;
        v_pos := v_pos + 1;
      end loop;

      if v_pass = 1 and pg_catalog.regexp_match(
        v_executable_definition,
        $re$(^|[^.[:alnum:]_])pg_catalog[[:space:]]*\.[[:space:]]*coalesce[[:space:]]*\($re$,
        'i'
      ) is not null then
        execute pg_catalog.regexp_replace(
          v_definition,
          'pg_catalog[[:space:]]*[.][[:space:]]*coalesce',
          'coalesce',
          'gi'
        );
        -- Re-read and rescan after the replacement so an unexpected source
        -- spelling cannot silently bypass the fail-closed check below.
        continue;
      end if;

      if pg_catalog.regexp_match(
        v_executable_definition,
        $re$(^|[^.[:alnum:]_])coalesce[[:space:]]*\($re$,
        'i'
      ) is null then
        raise exception 'gateway function lacks an executable COALESCE expression: %', v_signature;
      end if;
      exit;
    end loop;
  end loop;
end;
$$;
