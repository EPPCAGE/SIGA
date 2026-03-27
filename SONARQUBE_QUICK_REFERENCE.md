# ⚡ QUICK REFERENCE — Top 10 Issues & Action Items

## 1️⃣ CRITICAL: switchPop() Cognitive Complexity

**Line 4713** | **Type:** S3776 | **Complexity:** 25/15 (+10) | **Risk:** 🔴 CRITICAL

| Property | Value |
|----------|-------|
| Functions impacted | Navigation, view switching |
| Effort | 3-4 hours |
| Status | Needs refactor into 5 helper functions |
| **Action** | **Extract: _restorePrevPopState, _updatePopDisplay, _setPopSection, _updatePopLabel, _renderPopModules** |

---

## 2️⃣ CRITICAL: sanitizePop() Cognitive Complexity

**Line 5120** | **Type:** S3776 | **Complexity:** 22/15 (+7) | **Risk:** 🔴 CRITICAL

| Property | Value |
|----------|-------|
| Functions impacted | Data loading, saving, POP initialization |
| Effort | 3 hours |
| Status | Needs refactor with schema validator |
| **Action** | **Extract field sanitization into schema-driven loop** |

---

## 3️⃣ CRITICAL: SVG Role Accessibility

**Line 1399** | **Type:** HTML-W3C | **Occurrences:** 1 | **Risk:** 🔴 CRITICAL

| Property | Value |
|----------|-------|
| Issue | `<svg role="img">` should be `<img>` |
| WCAG | 2.1 A/AA Non-compliant |
| Effort | 5 minutes |
| Status | Simple tag conversion |
| **Action** | **Convert SVG to data:image/svg+xml base64 or <img>** |

---

## 4️⃣ CRITICAL: 44× DIV→Button Migration

**Lines 1481, 1560, 1568, 1574, 1583-1643, 2489, 2727, +36 more** | **Type:** S6379 | **Risk:** 🔴 CRITICAL

| Property | Value |
|----------|-------|
| Pattern | `<div onclick="..." role="button" tabindex="0">` |
| Count | 44 occurrences |
| Effort | 2-3 hours (batch convert) |
| Status | Batch refactor needed |
| **Action** | **Replace all <div onclick role="button"> with <button>** |

---

## 5️⃣ HIGH: toggleEditMode() Cognitive Complexity

**Line 4810** | **Type:** S3776 | **Complexity:** 19/15 (+4) | **Risk:** 🟠 MEDIUM

| Property | Value |
|----------|-------|
| Functions impacted | Edit mode toggle, UI update |
| Effort | 1.5 hours |
| Status | Extract 2-3 helper functions |
| **Action** | **Extract: _enableEditableFields, _updateEditUI** |

---

## 6️⃣ HIGH: Negated Conditions (14 occurrences)

**Lines 4492, 4529, 4555, 4583, 4606, 4608, 4619, 4624, 4629, 4639, 4642, 4653, 4669, +1 more** | **Type:** S1940 | **Risk:** 🟠 MEDIUM

| Property | Value |
|----------|-------|
| Pattern | `if(!variable) return;` |
| Count | 14-15 occurrences |
| Effort | 30-45 minutes |
| Status | Rewrite as positive condition or keep as guard clause |
| **Action** | **Invert logic or document as intentional guard clauses** |

---

## 7️⃣ HIGH: Ternary Operator (Inline HTML)

**Line 2648** | **Type:** S3358 | **Risk:** 🟠 MEDIUM

| Property | Value |
|----------|-------|
| Issue | Complex ternary embedded in onclick |
| Pattern | `onclick="(function(b){...const open=d.style.display!=='grid'...})(this)"` |
| Effort | 1 hour |
| Status | Extract to named function |
| **Action** | **Create toggleRelQuantBody(btn) function** |

---

## 8️⃣ HIGH: undoLastChange() Cognitive Complexity

**Line 5024** | **Type:** S3776 | **Complexity:** 18/15 (+3) | **Risk:** 🟠 MEDIUM

| Property | Value |
|----------|-------|
| Functions impacted | Undo/redo feature |
| Effort | 1.5 hours |
| Status | Extract render operations |
| **Action** | **Extract: _renderAllPopViews, _updateUndoUI** |

---

## 9️⃣ MEDIUM: TabIndex on Non-Interactive (20 occurrences)

**Lines 1585, 1586, 1591, 1592, 1597, 1598, 1603, 1604, 1609, 1610, 1615, 1616, 1621, 1622, 1627, 1628, 1633, 1634, 1639, 1640** | **Type:** HTML | **Risk:** 🟠 MEDIUM

| Property | Value |
|----------|-------|
| Pattern | `<div tabindex="0" role="button">` |
| Count | 20 occurrences |
| Status | Will be fixed by Issue #4 (DIV→Button migration) |
| **Action** | **Covered by DIV→Button batch (Issue #4)** |

---

## 🔟 MEDIUM: showSection() Cognitive Complexity

**Line 4777** | **Type:** S3776 | **Complexity:** 17/15 (+2) | **Risk:** 🟠 MEDIUM

| Property | Value |
|----------|-------|
| Functions impacted | Section/tab switching within POP |
| Effort | 45 minutes |
| Status | Single function extraction |
| **Action** | **Extract: _togglePOPSections** |

---

## 📊 DISTRIBUTION SUMMARY

```
HTML/Accessibility (66%):   96 alerts
├─ role="button" DIVs       44 ⚡ (Issues #4, #9)
├─ TabIndex issues          20 ⚡ (Issue #9, covered by #4)
├─ SVG/IMG role              4 ⚡ (Issue #3)
├─ Missing onKeyDown          2
└─ Interactive elements      26

JavaScript Complexity (20%): 30 alerts
├─ Cognitive Complexity      6 ⚡ (Issues #1, #2, #5, #8, #10)
├─ Negated conditions        14 ⚡ (Issue #6)
└─ Other logic               10

Code Smell (8%):             12 alerts
├─ Ternary operators         8 ⚡ (Issue #7)
└─ Other smells              4

CSS/Misc (6%):               8 alerts
```

---

## ✅ IMPLEMENTATION CHECKLIST

### PHASE 1: CRITICAL (2-3 hours, TODAY)
- [ ] Issue #3: Fix SVG role (1 line)
- [ ] Issue #1: Refactor switchPop() into 5 helpers
- [ ] Backup: `index.html.backup-phase1-[timestamp].html`
- [ ] Test: Navigation (Home → POP → Back)
- [ ] Re-run SonarQube: Expect -8 alerts

### PHASE 2: HIGH (3-4 hours, TOMORROW)
- [ ] Issue #2: Refactor sanitizePop() with schema
- [ ] Issue #4: Convert 44 DIVs to <button> (batch)
- [ ] Issue #5: Refactor toggleEditMode()
- [ ] Backup: `index.html.backup-phase2-[timestamp].html`
- [ ] Test: Edit mode, home cards, keyboard nav
- [ ] Re-run SonarQube: Expect -40 alerts

### PHASE 3: MEDIUM (2-3 hours, THIS WEEK)
- [ ] Issue #6: Rewrite 14 negated conditions
- [ ] Issue #7: Extract ternary operator
- [ ] Issue #8: Refactor undoLastChange()
- [ ] Issue #10: Refactor showSection()
- [ ] Backup: `index.html.backup-phase3-[timestamp].html`
- [ ] Test: Full feature coverage
- [ ] Re-run SonarQube: Expect -15 alerts

---

## 📈 EXPECTED RESULTS

| Metric | Before | After Phase 1 | After Phase 2 | After Phase 3 |
|--------|--------|---------------|---------------|---------------|
| Total Alerts | 146 | 138 | 98 | 83 |
| % Reduction | 0% | 5% | 33% | 43% |
| Cognitive Issues | 6 | 5 | 4 | 2-3 |
| Accessibility | 96 | 96 | 52 | 52 |
| Code Smell | 12 | 9 | 9 | 5 |
| **Quality Grade** | **C+** | **C+** | **B-** | **B/B+** |

---

## 🚀 DEPLOYMENT NOTES

- **Zero breaking changes** — All fixes are refactoring only
- **No API changes** — All external interfaces remain identical
- **Full backward compatibility** — Test suite should pass 100%
- **Performance:** No degradation expected (improvements possible)
- **Accessibility:** Will improve significantly (WCAG 2.1)

---

**Generated:** 2026-03-27 | **Next Review:** 2026-03-28 (Phase 2)
