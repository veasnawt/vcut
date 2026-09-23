# Missing VCut icons

These editor-specific icons are not currently available in `@veasnawt/vicons`. VCut uses the listed
temporary fallbacks in `src/ui/VCutApp.tsx` until purpose-built icons are added.

| Suggested icon name | Intended visual | Toolbar use | Temporary fallback |
| --- | --- | --- | --- |
| `TransitionBlend` | Two adjacent or overlapping clip frames merging across their shared cut | Transition | Local `TransitionGlyph`, shared with timeline junctions |
| `ImageFilters` | Three offset adjustment sliders, optionally inside a photo frame | Filters | `Art` |
| `VisualEffects` | A magic wand with two or three sparkles | Effects | `Grid` |

All three should use the existing 24×24 outline style, rounded line caps and joins, and accept the
standard `IconProps` used throughout `@veasnawt/vicons`.
