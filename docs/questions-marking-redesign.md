# Questions & Marking Round Visual Redesign

We are rolling out a purely visual refresh for the Questions and Marking phases. Gameplay rules, control flow, navigation, and data bindings must remain identical to the current implementation. Treat this work as a skin swap with zero behaviour changes unless explicitly noted below.

## Layout
- Both rounds render inside the same fixed-width rectangular content card used today.
- Replace the sequential question/marking navigation with a three-tab interface sitting along the top edge of the card.
- Tabs are labelled `1`, `2`, and `3`, each representing a single question (or marking item).
- Selecting a tab instantly swaps the content area beneath the tabs to the corresponding item. Players can move freely between tabs at any time.

## Questions Round Interactions
- Choosing an answer on a tab marks that tab as “answered”.
- The selected answer option is highlighted using a darker tint of that tab’s background colour.
- Answers remain editable until the player presses **Submit**.
- A Submit button lives beneath the tabbed card; it only becomes active once all three tabs have an answer selected.
- Submitting locks the responses and advances exactly as the current flow does.

## Marking Round Interactions
- Uses the same tab shell, but the per-question controls are the ✓ / ? / ✕ buttons instead of multiple-choice answers.
- Each choice highlights the tab using that tab’s colour; selections may be changed until Submit.
- Submit behaviour mirrors the existing implementation.
- The Maths side panel is removed for now and will return in a later post-round screen.

## Visual Language
- Tabs carry soft, pale background colours (one unique colour per tab) that extend downward to fill the active tab’s content area, creating a single coloured block.
- The active tab and its content share the same colour. The chosen answer (or marking state) uses a richer/darker version of that colour for emphasis.
- Tabs feature subtle shadows and smooth rounded corners for a modern, compact feel.
- Maintain the current typography, spacing scale, and overall clean infographic vibe—minimal, confident, and uncluttered.
- Round headings become single-word titles: `Questions` during the question phase and `Marking` during the marking phase.

## Constraints & Non-Goals
- Do not alter business logic, timers, submission rules, or data writes.
- Keep all elements within the established layout width and alignment conventions.
- Ensure the tab system and its states feel cohesive across both rounds.
- This work is strictly visual; treat any behavioural deviations as regressions.
