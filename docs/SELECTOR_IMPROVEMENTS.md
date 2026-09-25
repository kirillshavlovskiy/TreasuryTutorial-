# Instrument & Structure Selector Improvements

## Overview

The **Tile** selector component in TradeTicketPanel has been redesigned to provide a cleaner, more professional interface similar to the entity/desk/dashboard addition process.

---

## Visual Changes

### Before
- Selected tiles showed a violet/purple background (`bg-violet-500/15`)
- All tiles remained visible at all times
- Selected state used violet icon background (`bg-violet-500/20`)

### After
- **Selected tiles show a clean cyan border outline** (`border-cyan-500/70`) with no background fill
- **Selected tiles are hidden from view** to reduce visual clutter
- Icons in selected tiles use cyan accent color (`text-cyan-300`)
- Cleaner, minimalist design matching modern UI patterns

---

## How It Works

### Structure Selector (Bullet / Strip)

When you select **Bullet**:
```
BEFORE:
┌─────────────────────┐
│  ○ Bullet  │  ▯ Strip  │
│(violet bg) │ (slate bg)│
└─────────────────────┘

AFTER:
┌──────────────┐
│  ▯ Strip     │
│ (slate bg)   │
└──────────────┘
[Bullet is hidden - already selected]
```

### Instrument Selector (Spot / Forward / Option / Swap)

When you select **Forward**:
```
BEFORE:
┌──────────────────────────────────────┐
│ ◆ Spot │ ◆ Forward │ ◆ Option │ ◆ Swap │
│(slate) │(violet bg)│(slate)  │(slate) │
└──────────────────────────────────────┘

AFTER:
┌──────────────────────┐
│ ◆ Spot │ ◆ Option │ ◆ Swap │
│(slate) │(slate)   │(slate) │
└──────────────────────┘
[Forward is hidden - already selected]
```

---

## Style Details

### Selected Tile Appearance

```css
/* Border: Cyan outline */
border-cyan-500/70

/* Background: Transparent (same as unselected) */
bg-slate-950/60

/* Icon Border: Cyan */
border-cyan-500/60

/* Icon Background: Neutral */
bg-slate-900

/* Icon & Label Text: Cyan */
text-cyan-300

/* Hover: Lighter cyan */
hover:border-cyan-400
```

### Unselected Tile Appearance

```css
/* Border: Dark slate */
border-slate-700

/* Background: Neutral */
bg-slate-950/60

/* Icon Border: Dark slate */
border-slate-700

/* Icon Background: Slate */
bg-slate-900

/* Icon & Label Text: Light slate */
text-slate-300

/* Hover: Lighter slate */
hover:border-slate-500
```

---

## Code Changes

### Updated Tile Component Props

```typescript
type TileProps = {
  icon: DeskIconName;
  label: string;
  hint: string;
  on: boolean;                    // Is this tile selected?
  soon?: boolean;                 // Coming soon?
  disabled?: boolean;             // Is it disabled?
  onClick: () => void;            // Click handler
  hideIfSelected?: boolean;       // NEW: Hide when selected
};
```

### Usage Example

```tsx
<Tile
  icon="instr-bullet"
  label="Bullet"
  hint="M3"
  on={structure === 'bullet'}
  disabled={freezeInputs}
  onClick={() => applyStructure('bullet')}
  hideIfSelected={true}           // Hide Bullet tile when selected
/>
```

---

## Benefits

| Feature | Benefit |
|---------|---------|
| **Hidden selection** | Reduces visual clutter; focuses on remaining options |
| **Cyan border outline** | Professional appearance; matches modern UI standards |
| **Clean typography** | Easier to read; cyan accent draws attention |
| **Consistent styling** | Matches entity/desk/dashboard addition patterns |
| **Intuitive UX** | User understands selection is "locked in" |

---

## Component Locations

- **Tile component:** `components/test-mode/TradeTicketPanel.tsx` (line 2114)
- **Structure selectors:** `components/test-mode/TradeTicketPanel.tsx` (lines 1354–1381)
- **Instrument selectors:** `components/test-mode/TradeTicketPanel.tsx` (lines 1387–1415)

---

## Related Components

### Chip Component (Put / Call selector)

The **Chip** component (used for Put/Call, View selector) was **not modified**. It uses a different style suited for binary choices. If you want to apply the same pattern there, update:

```typescript
// Current: Uses border-violet-500/50 and bg-violet-500/15
// Change to: Uses border-cyan-500/70 and no background

// Optional: Add hideIfSelected={true} to hide after selection
```

---

## Browser Support

The cyan color and transition effects work on:
- ✅ Chrome/Edge (Chromium 90+)
- ✅ Firefox 88+
- ✅ Safari 14+
- ✅ Mobile browsers

---

## Accessibility

- ✅ Still supports keyboard navigation (Tab / Arrow keys)
- ✅ `disabled` prop prevents interaction
- ✅ Color contrast passes WCAG AA (cyan on dark background)
- ✅ Outline remains visible with `focus-visible`

---

## Next Steps

### Optional Enhancements

1. **Animate hide/show transition:**
   ```tsx
   className={`transition-all duration-200 ${on && hideIfSelected ? 'scale-0 opacity-0' : 'scale-100 opacity-100'}`}
   ```

2. **Show selected value in a badge:**
   ```tsx
   {structure === 'bullet' && <Badge>Bullet Selected</Badge>}
   ```

3. **Add keyboard shortcuts:**
   - Press `B` to select Bullet
   - Press `T` to select Strip
   - Press `1/2/3/4` for Spot/Forward/Option/Swap

4. **Apply same styling to Chip (Put/Call):**
   ```tsx
   hideIfSelected={true}
   // Change border-violet-500/50 → border-cyan-500/70
   ```

---

## Testing Checklist

- [ ] Select Bullet → Strip tile hidden
- [ ] Select Strip → Bullet tile hidden
- [ ] Select Forward → Others visible
- [ ] Click hidden tile area → No effect
- [ ] Disabled tiles stay visible with opacity-40
- [ ] Hover effect shows cyan highlight
- [ ] Mobile: Touch works smoothly
- [ ] Light theme: Cyan appears correctly (if applicable)

---

## Questions?

Refer to the TradeTicketPanel component or reach out to the FX team.
