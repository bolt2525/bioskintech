# Eventos estacionales y "dongles" interactivos

Sistema reutilizable del dashboard. Todo se configura en
`src/components/admin/dashboard/seasonalEvents.ts` (sin tocar `AdminDashboard.tsx`).

## Piezas

| Pieza | Archivo | Qué hace |
|---|---|---|
| Catálogo de eventos | `seasonalEvents.ts` | Fechas, textos, tema, dongle, atmósfera e interacción |
| Dongle de marca | `SeasonalBrandDongle.tsx` | Emoji colgante junto al nombre de la clínica + popover con CTA |
| Atmósfera del hero | `SeasonalHeroAtmosphere.tsx` | Telarañas / nieve / polvo de estrellas (fondo, decorativo) |
| Interacción del hero | `SeasonalHeroInteraction.tsx` | Mascota clicable + criatura que vuela hasta el nombre |

## Agregar un evento

1. Añadir un objeto a `SEASONAL_EVENTS` con `startDate`/`endDate` (`MM-DD`, ambos inclusive; puede cruzar fin de año).
2. Textos del popover orientados a la acción: `dongle.popoverTitle` (gancho), `dongle.tooltipTip` (el porqué),
   `actionLabel` + `actionPath` (CTA, ej. «Agendar pacientes» → `/admin/agenda`).
3. `atmosphere` (variante de fondo y color) y, opcionalmente, `heroInteraction`.

Halloween: `10-10` → `11-01`.

## `heroInteraction` (mascota + criatura)

```ts
heroInteraction: {
  mascot: 'spider',     // elemento clicable en la esquina del hero
  summon: 'ghost',      // lo que sale al hacer clic: vuela a la izquierda y se posa sobre el nombre
  hint: '¡Aplástame!',  // pista al hover/foco
  ariaLabel: '…',       // etiqueta accesible del botón
  perchMs: 4500,        // (opcional) tiempo posado
}
```

Flujo: clic → la mascota se aplasta → "puf" de humo → la criatura vuela con curva orgánica y estela
hacia el elemento `[data-hero-name]` (el `<span>` del nombre en el saludo) → se posa flotando → se desvanece.
Un nuevo clic reinicia el vuelo. Con `prefers-reduced-motion` no hay vuelo: aparece posada directamente.

### Agregar una mascota o criatura nueva (ej. Navidad: Santa + regalo)

1. Ampliar los tipos `HeroMascotKind` / `HeroSummonKind` en `seasonalEvents.ts` (`'santa'`, `'gift'`).
2. En `SeasonalHeroInteraction.tsx`:
   - Mascota: componente que cumpla `MascotProps` (usa `squashed` para su reacción al clic y llama a
     `onActivate(rect)` con el `DOMRect` del botón) y registrarlo en `MASCOTS`.
   - Criatura: sprite SVG `({ color }) => <svg/>` (≈30 px de ancho) y registrarlo en `SUMMONS`.
3. Usarlos en el evento:
   ```ts
   heroInteraction: { mascot: 'santa', summon: 'gift', hint: '¡Toca a Santa!', ariaLabel: '…' }
   ```
   El TypeScript fallará si falta una entrada en los registros.

Otras ideas: Año Nuevo → copa/estrella fugaz, San Valentín → cupido + corazón.

## Reglas
- Solo `transform`/`opacity`; contenido visible en español; la capa interactiva es `pointer-events-none`
  y únicamente la mascota recibe eventos; el hero contenedor debe ser `relative overflow-hidden`.
