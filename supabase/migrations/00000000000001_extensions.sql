-- Phase 1: baseline extensions
create extension if not exists "pgcrypto" with schema public;
create extension if not exists "citext" with schema public;
