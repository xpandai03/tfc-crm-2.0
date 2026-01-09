# TFC CRM Demo - Design Guidelines

## Design Approach

**Selected System:** Linear-inspired productivity design with Material Design data components  
**Rationale:** This admin tool replaces spreadsheet workflows, requiring clean information hierarchy, fast scanning, and efficient task completion. Linear's minimal approach prevents cognitive overload while Material's robust data components ensure dense information displays remain readable.

## Core Design Elements

### Typography
- **Primary Font:** Inter (Google Fonts CDN)
- **Monospace:** JetBrains Mono for IDs/codes
- **Hierarchy:**
  - Page titles: text-2xl font-semibold
  - Section headers: text-lg font-medium
  - Card titles: text-base font-medium
  - Body text: text-sm
  - Metadata/timestamps: text-xs text-gray-500

### Layout System
**Spacing primitives:** Tailwind units of 2, 4, 6, 8, 12, 16  
- Card padding: p-4 or p-6
- Section gaps: gap-4 or gap-6
- Page margins: px-6 py-8 on mobile, px-8 py-12 on desktop
- Component spacing: space-y-4 for vertical stacks

### Component Library

**Dashboard Cards:**
- Clean white backgrounds with subtle borders (border border-gray-200)
- Rounded corners: rounded-lg
- Minimal shadows: shadow-sm, shadow-md on hover
- Priority indicators via left border accent (border-l-4)

**Priority Queue Cards:**
- High priority (>60 days): Red left accent border-l-red-500
- Medium priority (ready): Amber left accent border-l-amber-500
- Standard (follow-up): Blue left accent border-l-blue-500
- Each card shows: Name (bold), service type, days waiting (prominent badge)

**Kanban/Pipeline Columns:**
- Column headers with count badges: "Intake (24)"
- Drag-drop visual affordance (subtle hover lift)
- Cards: Compact height, consistent width, clear status indicators
- Column background: bg-gray-50 to differentiate from cards

**Contact Detail Layout:**
- Two-column layout on desktop (8:4 ratio)
- Left: Contact info, timeline, notes input
- Right: AI insight panel (sticky position)
- Status dropdown: Large, prominent, color-coded

**Metrics Display:**
- Large number typography: text-4xl font-bold
- Supporting label: text-sm text-gray-600
- Grid layout: grid-cols-2 md:grid-cols-4
- Trend indicators with icons (↑ ↓)

**AI Insight Panel:**
- Distinct visual treatment: bg-blue-50 border border-blue-200
- Icon: Sparkle/lightbulb from Heroicons
- Label: "AI Insight" in small caps
- Suggested action as button or link below insight text
- Non-blocking: Never interrupts workflow

**Navigation:**
- Top horizontal nav bar with logo left, navigation center
- Active state: Bottom border accent (border-b-2)
- Clean, minimal: No background color, relies on white space

**Tables/Lists:**
- Striped rows for scannability: odd:bg-gray-50
- Sticky headers on scroll
- Row hover state: hover:bg-gray-100
- Compact row height: py-3

**Forms:**
- Full-width inputs with clear labels above
- Focus states: ring-2 ring-blue-500
- Helper text below inputs: text-xs text-gray-600
- Notes textarea: Auto-expanding, min-h-24

**Badges/Status:**
- Pill-shaped: rounded-full px-3 py-1 text-xs
- Status-specific colors:
  - Active: bg-green-100 text-green-800
  - Waiting: bg-yellow-100 text-yellow-800
  - On Hold: bg-gray-100 text-gray-800
  - Scheduled: bg-blue-100 text-blue-800

**Icons:**
- Use Heroicons via CDN (outline style primarily)
- Size: 16px (h-4 w-4) for inline, 20px (h-5 w-5) for standalone
- Color: text-gray-400 default, inherit on hover/active

### Animations
**Minimal use only:**
- Card hover lift: transition-transform duration-200 hover:translate-y-[-2px]
- Loading states: Simple spinner, never skeleton screens
- Status changes: 200ms fade transition
- NO page transitions, NO scroll animations

### Page-Specific Layouts

**Home/Today View:**
- Hero metrics bar at top (4-col grid)
- Priority queues below in 3-column grid (lg:grid-cols-3)
- Each queue as scrollable card container (max-h-96 overflow-y-auto)
- AI suggestions panel: Fixed width sidebar on xl screens, full-width section on mobile

**Waitlist View:**
- Full-width kanban board
- Horizontal scroll on mobile
- Column min-width: 280px
- Cards: Consistent height for alignment

**Contact Detail:**
- Breadcrumb navigation at top
- Contact header with avatar placeholder, name, primary service
- Tabbed sections: Overview, Timeline, Notes
- AI panel always visible on right (desktop)

**Insights View:**
- Dashboard-style with metric cards
- Charts/graphs: Simple bar charts using HTML/CSS (no charting library needed for demo)
- Time period selector: Dropdown or segmented control at top
- Export button (non-functional in demo): Top-right corner

## Critical UX Patterns

**Loading States:**
- Skeleton loaders ONLY for initial page load
- In-app updates: Optimistic UI + subtle loading indicator in corner
- Never block user actions for AI responses

**Error Handling:**
- Toast notifications (top-right, auto-dismiss 5s)
- Inline validation errors on forms (red text below field)
- Empty states with actionable copy: "No contacts found. Try adjusting filters."

**Data Density:**
- Compact by default (spreadsheet users expect density)
- Toggle for "comfortable" spacing (optional feature)
- Always show critical info first: name, status, days waiting

**Speed Indicators:**
- Immediate visual feedback on all clicks
- Progress indication for webhook calls
- Clear timestamp on last data refresh

This design prioritizes **speed, clarity, and confidence** - admins should feel the UI is faster than their spreadsheet, clearer than their current process, and trustworthy enough to make decisions quickly.