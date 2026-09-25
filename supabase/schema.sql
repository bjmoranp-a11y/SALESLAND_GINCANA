-- Ejecuta esto en Supabase: Dashboard > SQL Editor > New query > Run

create table if not exists public.asistencia (
  id bigint generated always as identity primary key,
  dni text not null,
  asistente text not null,
  coordinador text not null,
  campana text not null,
  escaneado_en timestamptz not null default now(),
  escaneado_por text
);

-- Evita que el mismo DNI se registre dos veces (segundo escaneo = "ya registrado")
create unique index if not exists asistencia_dni_unique on public.asistencia (dni);

alter table public.asistencia enable row level security;

-- La app usa la clave "anon" pública, así que necesita permiso explícito
-- para insertar y leer. Ajusta esto si luego quieres restringirlo más.
drop policy if exists "asistencia_insert_anon" on public.asistencia;
create policy "asistencia_insert_anon"
  on public.asistencia for insert
  to anon
  with check (true);

drop policy if exists "asistencia_select_anon" on public.asistencia;
create policy "asistencia_select_anon"
  on public.asistencia for select
  to anon
  using (true);
