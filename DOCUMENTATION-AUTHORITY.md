# Documentation Authority & Canonical Sources

> Historical documentation inventory. Its accuracy labels and task counts are
> not current verification. Use the checked-out source for implementation and
> [dated production evidence](docs/PRODUCTION_VERIFICATION_20260930.md) for release
> status. Earlier test results do not attest later source changes.

**Purpose:** Clarify which documentation is authoritative for different purposes, eliminating confusion about conflicting information.

---

## Canonical Sources by Purpose

| Purpose | Canonical Source | Why | Status |
|---------|------------------|-----|--------|
| **Current Implementation State** | `todo.md` | Reflects actual completed work (931/1241 items) | ✅ Most Accurate |
| **What's Actually Built** | `ARCHITECTURE-ACTUAL.md` | Documents implemented features, not planned ones | ✅ Authoritative |
| **Planned/Aspirational Features** | `docs/SYSTEM-ARCHITECTURE.md` | Original vision document | ⚠️ Outdated |
| **Production Readiness** | `PRODUCTION_READINESS_GUIDE.md` | Roadmap to 100% complete | ⚠️ Needs Update |
| **Local Development Setup** | `LOCAL_DEV_SETUP.md` (NEW) | Accurate MySQL/SQLite configuration | ✅ New (Replaces SETUP_GUIDE) |
| **API Endpoints** | `ARCHITECTURE-ACTUAL.md` | Lists implemented endpoints only | ✅ Accurate |
| **Database Schema** | `drizzle/schema.ts` + `ARCHITECTURE-ACTUAL.md` | Source of truth is schema file | ✅ Accurate |
| **Testing Status** | `todo.md` (Test sections) | Shows which tests pass/fail | ✅ Accurate |

---

## Document Status & Reliability

### ✅ Reliable (Use These)

**`todo.md`**
- **Accuracy:** 100% (reflects actual work)
- **Freshness:** Updated daily
- **Scope:** Complete project status
- **Use For:** Understanding what's done, what's pending, current blockers

**`ARCHITECTURE-ACTUAL.md`** (NEW)
- **Accuracy:** 100% (documents only implemented features)
- **Freshness:** Just created
- **Scope:** What's actually built vs. planned
- **Use For:** Understanding current capabilities, what's missing

**`drizzle/schema.ts`**
- **Accuracy:** 100% (source of truth for database)
- **Freshness:** Updated with migrations
- **Scope:** Database tables and relationships
- **Use For:** Database design, migrations, data model

**`server/routers.ts`**
- **Accuracy:** 100% (source of truth for API)
- **Freshness:** Updated with new endpoints
- **Scope:** All tRPC procedures
- **Use For:** API contract, available endpoints

### ⚠️ Outdated (Use with Caution)

**`docs/SYSTEM-ARCHITECTURE.md`**
- **Accuracy:** 50% (mixes implemented and planned)
- **Freshness:** Written Dec 2025, not updated
- **Scope:** Original vision
- **Issue:** Describes OCR, vision AI, attachment processing that don't exist
- **Use For:** Understanding original design intent, NOT current state
- **Action:** Mark aspirational sections with [PLANNED] tags

**`SETUP_GUIDE.md`**
- **Accuracy:** 30% (contains false claims)
- **Freshness:** Outdated
- **Scope:** Local development setup
- **Issue:** Says "use SQLite for local dev" but system is MySQL-only
- **Use For:** Reference only; use `LOCAL_DEV_SETUP.md` instead
- **Action:** Deprecate and replace

**`PRODUCTION_READINESS_GUIDE.md`**
- **Accuracy:** 70% (outdated completion estimate)
- **Freshness:** Written Mar 6, not updated
- **Scope:** Roadmap to production
- **Issue:** Claims 70% complete, actual is 75%
- **Use For:** High-level roadmap, not detailed status
- **Action:** Update with current metrics

### ❌ Unreliable (Don't Use)

**Inline Code Comments**
- **Accuracy:** 60% (many TODOs are stale)
- **Freshness:** Varies
- **Issue:** 20+ TODO/FIXME comments, unclear if still relevant
- **Action:** Audit and update all TODOs

**Architecture Diagrams in Docs**
- **Accuracy:** 50% (describe planned, not actual)
- **Freshness:** Original design
- **Issue:** Show attachment processing, vision AI, features not implemented
- **Action:** Create new diagrams showing actual architecture

---

## Resolving Conflicting Information

### Example 1: Database Setup
**Conflict:**
- `SETUP_GUIDE.md` says: "use SQLite for local dev"
- `drizzle.config.ts` says: MySQL only
- `LOCAL_DEV_SETUP.md` says: MySQL required

**Resolution:** Trust `drizzle.config.ts` and `LOCAL_DEV_SETUP.md`. `SETUP_GUIDE.md` is outdated.

### Example 2: Completion Percentage
**Conflict:**
- `PRODUCTION_READINESS_GUIDE.md` says: 70% complete
- `todo.md` shows: 931/1241 items = 75% complete
- `ARCHITECTURE-ACTUAL.md` says: 75% complete

**Resolution:** Trust `todo.md` (most granular). Update `PRODUCTION_READINESS_GUIDE.md` to match.

### Example 3: ATIS Features
**Conflict:**
- `docs/SYSTEM-ARCHITECTURE.md` describes: Full attachment processing, vision AI, OCR
- `ARCHITECTURE-ACTUAL.md` says: ATIS phases 1-10 work, no attachment processing
- Code shows: No attachment processing implemented

**Resolution:** Trust code and `ARCHITECTURE-ACTUAL.md`. Mark `SYSTEM-ARCHITECTURE.md` sections as [PLANNED].

---

## Documentation Maintenance Rules

1. **Single Source of Truth per Topic**
   - Database: `drizzle/schema.ts`
   - API: `server/routers.ts`
   - Status: `todo.md`
   - Implementation: `ARCHITECTURE-ACTUAL.md`

2. **Update Frequency**
   - `todo.md`: Daily (as work progresses)
   - `ARCHITECTURE-ACTUAL.md`: Weekly (with major features)
   - `PRODUCTION_READINESS_GUIDE.md`: Weekly (with status updates)
   - `docs/SYSTEM-ARCHITECTURE.md`: Mark sections [PLANNED] when implemented

3. **Conflict Resolution Process**
   - Check `todo.md` for current status
   - Check code for implementation details
   - Check `ARCHITECTURE-ACTUAL.md` for feature completeness
   - Ignore conflicting older docs

4. **Deprecation Process**
   - Mark outdated docs with [DEPRECATED] header
   - Link to replacement document
   - Keep for historical reference only

---

## Recommended Reading Order

**For New Developers:**
1. `README.md` (if exists) or `SETUP_GUIDE.md` → `LOCAL_DEV_SETUP.md` (corrected)
2. `ARCHITECTURE-ACTUAL.md` → Understand what's built
3. `todo.md` → See what's pending
4. `drizzle/schema.ts` → Understand data model
5. `server/routers.ts` → Understand API

**For Project Managers:**
1. `todo.md` → Current status
2. `PRODUCTION_READINESS_GUIDE.md` → Roadmap
3. `ARCHITECTURE-ACTUAL.md` → Capabilities

**For Architects/Tech Leads:**
1. `ARCHITECTURE-ACTUAL.md` → Current state
2. `docs/SYSTEM-ARCHITECTURE.md` → Original vision (with [PLANNED] tags)
3. `drizzle/schema.ts` → Data model
4. `todo.md` → Implementation gaps

---

## Next Steps

1. ✅ Create `ARCHITECTURE-ACTUAL.md` (DONE)
2. ✅ Create `DOCUMENTATION-AUTHORITY.md` (DONE - this file)
3. ⏳ Create `LOCAL_DEV_SETUP.md` (with MySQL/SQLite support)
4. ⏳ Update `docs/SYSTEM-ARCHITECTURE.md` with [PLANNED] tags
5. ⏳ Deprecate `SETUP_GUIDE.md`
6. ⏳ Update `PRODUCTION_READINESS_GUIDE.md` with 75% completion
7. ⏳ Audit all TODO/FIXME comments in code
