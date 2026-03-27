# ⚡ SONARQUBE ALERTS — DATA TABLES ONLY

## 1. DISTRIBUTION (146 TOTAL)

| Category | Count | % | Risk | Primary Fix |
|----------|-------|---|------|-------------|
| HTML/Accessibility | 96 | 66% | 🟡 Med | Convert DIVs to <button> |
| JS Complexity | 30 | 20% | 🔴 High | Refactor 6 functions |
| Code Smell | 12 | 8% | 🟡 Med | Extract ternaries |
| CSS/Misc | 8 | 6% | 🟡 Low | Investigate residual |
| **TOTAL** | **146** | **100%** | — | — |

---

## 2. TOP 10 ISSUES (PRIORITY ORDER)

| Rank | Issue | Line | Type | Severity | Effort | Impact | Fix |
|------|-------|------|------|----------|--------|--------|-----|
| 🥇 1 | switchPop() Complexity 25/15 | 4713 | S3776 | 🔴 Critical | 3h | -3 alerts | Extract 5 helpers |
| 🥇 2 | sanitizePop() Complexity 22/15 | 5120 | S3776 | 🔴 Critical | 3h | -4 alerts | Schema validator |
| 🥇 3 | SVG role="img" | 1399 | HTML | 🔴 Critical | 0.1h | -1 alert | Convert tag |
| 🥇 4 | 44× DIV→Button | Multiple | S6379 | 🔴 Critical | 2.5h | -44 alerts | Batch convert |
| 🟠 5 | toggleEditMode() Complexity 19/15 | 4810 | S3776 | 🟠 High | 1.5h | -2 alerts | Extract 2 helpers |
| 🟠 6 | 14× Negated Conditions | 4492+ | S1940 | 🟠 High | 0.75h | -8 alerts | Invert logic |
| 🟠 7 | 8× Ternary Operators | 2648+ | S3358 | 🟠 High | 1h | -12 alerts | Extract functions |
| 🟡 8 | undoLastChange() Complexity 18/15 | 5024 | S3776 | 🟡 Med | 1.5h | -2 alerts | Extract 2 helpers |
| 🟡 9 | 20× TabIndex Issues | 1585+ | HTML | 🟡 Med | Covered | Covered | By Issue #4 |
| 🟡 10 | showSection() Complexity 17/15 | 4777 | S3776 | 🟡 Med | 0.75h | -1 alert | Extract 1 helper |

---

## 3. CRITICAL FIXES (TODAY)

| Issue | Line | Before | After | Reduction |
|-------|------|--------|-------|-----------|
| SVG role | 1399 | `<svg role="img">` | `<img>` or wrapped div | 1 line |
| switchPop() | 4713 | 25 Complexity | ~14 Complexity | 5 helper funcs |
| **Phase 1 Total** | — | — | — | **-8 alerts** |

---

## 4. HIGH PRIORITY (TOMORROW)

| Issue | Lines | Count | Before | After | Reduction |
|-------|-------|-------|--------|-------|-----------|
| sanitizePop() | 5120 | 1 func | 22 Complexity | ~10 Complexity | -4 alerts |
| DIV→Button | 1481+ | 44 | `<div role="button">` | `<button>` | -44 alerts |
| toggleEditMode() | 4810 | 1 func | 19 Complexity | ~12 Complexity | -2 alerts |
| **Phase 2 Total** | — | — | — | — | **-50 alerts** |

---

## 5. MEDIUM PRIORITY (THIS WEEK)

| Issue | Lines | Count | Change | Impact |
|-------|-------|-------|--------|--------|
| Negated Conditions | 4492+ | 14 | Invert or document | -8 alerts |
| Ternary Extraction | 2648+ | 8+ | Extract to functions | -12 alerts |
| undoLastChange() | 5024 | 1 | Extract helpers | -2 alerts |
| showSection() | 4777 | 1 | Extract helper | -1 alert |
| **Phase 3 Total** | — | — | — | **-23 alerts** |

---

## 6. ALERT REDUCTION ROADMAP

| Phase | Timeline | Tasks | Effort | Alert Reduction | Running Total |
|-------|----------|-------|--------|-----------------|----------------|
| **Phase 1** | Today | SVG fix + switchPop | 3.1h | -8 | 146 → 138 |
| **Phase 2** | Tomorrow | sanitizePop + 44 DIVs + toggleEditMode | 3.5h | -50 | 138 → 88 |
| **Phase 3** | This Week | negated + ternary + undo + showSection | 2.5h | -23 | 88 → 65 |
| **Residual** | Optional | CSS/misc cleanup | 1h | -8 | 65 → 57 |
| — | **TOTAL** | — | **~10h** | **-89 alerts** | **146 → ~57** |

---

## 7. SONARQUBE METRICS

### Before (Today)
```
Total Issues:        146
Critical:             0
High:                 6 (Cognitive Complexity)
Medium:              96 (Accessibility)
Low:                 44
Quality Grade:      C+
Passing Quality Gate: ❌ NO
```

### After Phase 3
```
Total Issues:        65
Critical:             0
High:                 1
Medium:              26
Low:                 38
Quality Grade:       B/B+
Passing Quality Gate: ✅ YES (Meta: A)
```

---

## 8. EFFORT BREAKDOWN

| Task | Hours | % |
|------|-------|---|
| Code changes | 7.2 | 72% |
| Testing | 1.5 | 15% |
| Review/Backup | 1.3 | 13% |
| **Total** | **10** | **100%** |

---

## 9. FILE LOCATIONS FOR REFERENCE

| Document | Purpose | Location |
|----------|---------|----------|
| Analysis (Full) | Detailed 10 issues + solutions | SONARQUBE_QUALITY_ANALYSIS_146ALERTS.md |
| Quick Ref | Checklists + action items | SONARQUBE_QUICK_REFERENCE.md |
| Executive | Roadmap + metrics + timeline | SONARQUBE_EXECUTIVE_SUMMARY.md |
| This File | Data tables only | SONARQUBE_ALERTS_DATATABLES.md |
| Memory (Session) | Conversation history | /memories/session/sonar-analysis-146-alerts.md |
| Memory (Repo) | Project status | /memories/repo/siga-sonarqube-status.md |

---

## 10. RISK ASSESSMENT MATRIX

| Motion | Probability | Impact | Mitigation | Overall |
|--------|-------------|--------|-----------|---------|
| Navigatoin breaks after refactor | 5% | High | Test Phase 1 thoroughly | 🟢 Low |
| DIV→Button changes UI rendering | 10% | Medium | Keep onclick handlers identical | 🟢 Low |
| Undo feature regresses | 2% | Medium | Manual test undo/redo | 🟢 Low |
| Build fails SonarQube QG | 0% | High | Validation after each phase | 🟢 None |
| **Overall Risk** | — | — | — | 🟢 **LOW** |

---

## 11. SUCCESS CRITERIA

- ✅ Alerts reduced by 50%+ (target: 65-75)
- ✅ Quality Grade: C+ → B or higher
- ✅ Cognitive Complexity: 6 functions → 1-2
- ✅ Accessibility failures: 96 → <30
- ✅ All tests passing
- ✅ SonarCloud Quality Gate passes
- ✅ No runtime errors or regressions
- ✅ WCAG 2.1 compliance improved

---

## 12. TIMELINE GANTT SUMMARY

```
DAY 1 (TODAY):     [====] Phase 1 (3h)     146→138 alerts
DAY 2 (TOMORROW):  [======] Phase 2 (3.5h) 138→98 alerts
DAY 3-4 (WEEK):    [====] Phase 3 (2.5h)   98→65 alerts
```

---

**Status:** ✅ Analysis Complete | Ready for Implementation  
**Date:** 2026-03-27  
**Next:** Start Phase 1 (SVG role + switchPop refactor)
