# WAWUAfrica — Master Build Brief
# Complete agent instructions, API contracts, and phased task maps

---

## HOW TO USE THIS DOCUMENT

This brief is the source of truth for every Claude Code agent building the
WAWUAfrica ecosystem. Each stream is a separate Claude Code conversation.
Every agent gets: this document + the relevant repo link(s) + the relevant
design HTML files. Agents do NOT one-shot their stream — they follow the
phased task list and wait for confirmation between phases.

The API contracts in Section 3 are derived directly from the design files.
They are authoritative. Backend agents build to these contracts. Frontend
agents mock against these contracts then wire real calls progressively.

---

## SECTION 1 — SYSTEM OVERVIEW

### What exists today
- **WAWUAfrica backend** (`wawu-backend-pro`): Laravel 10, MySQL, Sanctum.
  Currently powers: Alison 10M learners onboarding form, EasyBuy submissions,
  VFD bank provisioning, admin moderation of onboarding. ~31,000 onboarding
  submissions. Dead V1 app code (gigs, chat, services, products) still in
  codebase but app is being taken down. V2 WAWUJobs code exists but is not
  used and moves to a separate codebase.
- **WAWUBeauty backend** (`-ojaewa-pro-api`): Laravel 12, MySQL, Sanctum.
  Full beauty/fashion e-commerce. Separate users table, separate Admin model,
  Google OAuth. Has SellerProfile, BusinessProfile, full product/order stack.
- **WAWUBasket backend** (`WAWUBasket-API`): NestJS, PostgreSQL, Prisma, Redis.
  Full food/agri e-commerce. Phone OTP → JWT auth. UUID user primary keys.
  Already has public catalog endpoint at GET /catalog/items.

### What gets built
- **WAWU ID**: New NestJS Railway project. Unified identity + auth for all apps.
- **WAWUAfrica hub API**: Extension of WAWUAfrica backend. Hub namespace
  added; dead code removed; existing onboarding preserved.
- **Hub frontend**: New Next.js 14 app. The main WAWUAfrica web experience.
- **WAWUBeauty + WAWUBasket**: Minor updates — WAWU ID middleware + catalog
  endpoints. Auth UI updated to reflect WAWU ID.

### Critical constraint
The onboarding submissions (~31,000 records) and the VFD bank provisioning
pipeline are LIVE and must not be disrupted. Touch nothing in:
`onboarding_submissions`, `onboarding_pre_registrations`, `onboarding_*` tables,
`easy_buy_submissions`, EasyBuy routes, onboarding routes.

---

## SECTION 2 — WAWU ID SPECIFICATION

### JWT Payload (authoritative — all apps verify this shape)
```json
{
  "sub": "uuid-v4",
  "email": "string",
  "phone": "string",
  "firstName": "string",
  "lastName": "string",
  "country": "string",
  "verificationTier": "basic|verified_user|verified_business|certified_professional|trusted_partner",
  "trustScore": 0,
  "status": "active|suspended|banned",
  "platformRefs": {
    "wawuafricaAppUserId": "int|null",
    "onboardingRef": "uuid|null",
    "beautyUserId": "int|null",
    "basketUserId": "uuid|null"
  },
  "iat": 1234567890,
  "exp": 1234567890
}
```

Access token TTL: 15 minutes. Refresh token TTL: 30 days.

### How apps verify tokens (no network call per request)
All apps fetch WAWU ID public key from `GET /.well-known/jwks.json` on startup,
cache it, and verify JWT signatures locally. Cache refreshes every 24 hours.
This means WAWU ID can go down without breaking active sessions.

### WAWU ID database schema (wawu_users table)
```
id: UUID (PK)
email: string unique
phone: string unique
first_name, last_name: string
country, state: string nullable
password_hash: string (argon2)
verification_tier: enum default 'basic'
trust_score: integer default 0
status: enum default 'active'
onboarding_ref: UUID nullable    -- → onboarding_submissions.uuid
wawuafrica_app_user_id: int nullable -- → WAWUAfrica users.id
beauty_user_id: int nullable     -- → WAWUBeauty users.id
basket_user_id: UUID nullable    -- → WAWUBasket users.id
created_at, updated_at
```

### WAWU ID endpoints
```
POST   /auth/register            — email+password+phone registration
POST   /auth/login               — email+password → {accessToken, refreshToken, user}
POST   /auth/otp/start           — {phone} → sends OTP
POST   /auth/otp/verify          — {phone, code} → {accessToken, refreshToken, user}
POST   /auth/refresh             — {refreshToken} → {accessToken, refreshToken}
POST   /auth/forgot-password     — {email} → sends reset link
POST   /auth/reset-password      — {token, email, password}
GET    /.well-known/jwks.json    — public key for JWT verification

INTERNAL (service-key header required):
GET    /internal/users/export?page=1&per_page=500  — provisioning export
PATCH  /internal/users/:id/trust-score   — {delta, reason}
PATCH  /internal/users/:id/verification-tier — {tier}
```

### User deduplication (provisioning job logic)
Produces 3 categories. Run once during migration:

**Category A** — exists in BOTH onboarding_submissions AND WAWUAfrica users
  (matched by email OR phone):
  - One WAWU ID record
  - Primary data from onboarding_submission (NIN/BVN verified)
  - Store users.id as wawuafrica_app_user_id
  - Store submission.uuid as onboarding_ref
  - Password from users table carries over → user can log in immediately

**Category B** — onboarding_submissions only (no matching users record):
  - One WAWU ID record from submission data
  - No password yet
  - Queue "Activate your WAWU ID" email with one-time password-setup link

**Category C** — WAWUAfrica users table only (never filled onboarding form):
  - One WAWU ID record from users table data
  - Password carries over
  - Store users.id as wawuafrica_app_user_id

Edge cases:
- Same email, different phone → prefer onboarding data, flag for admin review
- Soft-deleted users (deleted_at not null) → skip, do not provision
- Duplicate emails in users table (uniqueness was dropped in migration
  2025_07_14) → take earliest created_at record, flag duplicates

---

## SECTION 3 — API CONTRACTS (derived from design files)

### Base URL convention
All hub endpoints: `/api/hub/*`
All admin endpoints: `/api/admin/*`
All existing onboarding endpoints: `/api/onboarding/*` (UNCHANGED)

### Authentication header
```
Authorization: Bearer <wawu_id_jwt>
```

### Standard response envelope
```json
{
  "statusCode": 200,
  "message": "string",
  "data": {} or [],
  "pagination": { "current_page": 1, "next_page": 2, "per_page": 20, "total": 120 }
}
```

---

### 3.1 AUTH (WAWU ID handles this — not hub API)
See Section 2. The hub frontend calls WAWU ID directly for all auth.

---

### 3.2 FEED / POSTS

```
GET  /api/hub/feed
  query: filter=All|Learn|Sell|Opportunity|Event|Question|Research|Buy(=has_product)
         country=string
         following=true (topics/sections/businesses the user follows)
         page=1
  response: { data: Post[], pagination }

GET  /api/hub/feed/:id          — single post detail with full body + comments
POST /api/hub/posts             — create post (auth required)
  body: {
    category: "Learn|Sell|Opportunity|Event|Question|Research",
    title: string,
    body: string,
    tags: string[],
    productRef?: {             -- only if product attached
      platform: "WAWUBasket|WAWUBeauty",
      productId: string,
      sellerId: string,
      snapshot: { name, price, imageUrl }
    }
  }
  response: Post (status=pending for gated types, published for others)

POST /api/hub/posts/:id/vote
  body: { direction: "up|down|none" }

POST /api/hub/posts/:id/save   — toggle save

GET  /api/hub/posts/:id/comments
  response: { data: Comment[] (nested) }

POST /api/hub/posts/:id/comments
  body: { body: string }

POST /api/hub/comments/:id/replies
  body: { body: string }
```

**Post object shape:**
```json
{
  "id": "string",
  "category": "Learn",
  "variant": "generic|product|opportunity|event|training",
  "title": "string",
  "body": "string",
  "author": {
    "id": "uuid",
    "name": "string",
    "verificationTier": "basic|verified_user|...",
    "trustScore": 82
  },
  "votes": 128,
  "userVote": "up|down|none",
  "comments": 24,
  "isSaved": false,
  "isPending": false,
  "rejectionReason": null,
  "createdAt": "2026-06-04T10:00:00Z",
  "productRef": null or {
    "platform": "WAWUBasket",
    "productId": "string",
    "snapshot": { "name": "Ground Egusi · 500g", "price": "₦4,500", "imageUrl": "string" }
  },
  "opportunityMeta": null or { "org", "location", "deadline", "adminVerified": true },
  "eventMeta": null or { "month", "day", "location", "time" }
}
```

---

### 3.3 OPPORTUNITIES

```
GET  /api/hub/opportunities
  query: filter=All|Jobs|Grants|Funding|Scholarships|Tenders|Procurement|Accelerators|Competitions|Partnerships
         country=All|Nigeria|Ghana|Kenya|...
         page=1
  response: { data: Opportunity[], pagination }

GET  /api/hub/opportunities/:id
POST /api/hub/opportunities/:id/apply    — expression of interest
  body: { name, email, phone, country, motivation, documentUrl? }
  response: { message: "Application submitted" }

POST /api/hub/opportunities/:id/save    — toggle save
```

**Opportunity object shape:**
```json
{
  "id": "string",
  "type": "Grant|Funding|Tender|Scholarship|Accelerator|Partnership|Job",
  "filter": "Grants",
  "title": "string",
  "org": "string",
  "orgDesc": "string",
  "location": "string",
  "country": "string",
  "deadline": "Closes 30 Jun 2026",
  "closingSoon": false,
  "amount": "Up to ₦5,000,000",
  "salaryLabel": "Grant",
  "eligibility": "string",
  "desc": "string",
  "criteria": ["string"],
  "adminVerified": true,
  "status": "published|pending|rejected",
  "rejectionReason": null,
  "isSaved": false,
  "createdAt": "timestamp",
  "submittedBy": { "id": "uuid", "name": "string" }
}
```

---

### 3.4 EVENTS

```
GET  /api/hub/events
  query: filter=All|In-Person|Online|Workshop|Summit|Webinar|Meetup|Competition
         view=upcoming|past   (default: upcoming)
         page=1
  response: { data: Event[], pagination, featured: Event|null }

GET  /api/hub/events/:id
POST /api/hub/events/:id/going   — toggle going (hub interest signal only)
  response: { going: true|false, count: 128 }
```

**Event object shape:**
```json
{
  "id": "string",
  "featured": false,
  "month": "JUL", "day": "18", "dow": "Saturday",
  "time": "09:00 – 17:00", "tz": "WAT",
  "name": "string",
  "org": "string", "orgBio": "string",
  "orgTier": "business",
  "format": "In-Person|Online",
  "type": "Summit|Workshop|Webinar|Meetup|Competition",
  "location": "string", "address": "string",
  "thisWeek": false,
  "going": 128,
  "userGoing": false,
  "url": "external-registration-url",
  "desc": "string",
  "speakers": [{ "initials": "AO", "name": "string", "title": "string" }],
  "adminVerified": true,
  "status": "published|pending|rejected",
  "isPast": false
}
```

---

### 3.5 MARKETPLACE (hub proxy — reads from Basket + Beauty)

```
GET  /api/hub/marketplace/picks
  response: { data: Product[] }  -- 5 top picks from both platforms

GET  /api/hub/marketplace/basket/categories
  response: { data: [{ name, icon }] }

GET  /api/hub/marketplace/basket/products
  query: category?, search?, page=1
  response: { data: Product[], pagination }

GET  /api/hub/marketplace/beauty/categories
GET  /api/hub/marketplace/beauty/products
  query: category?, search?, page=1

GET  /api/hub/marketplace/products/:platform/:id
  response: Product (full detail for product detail screen)

GET  /api/hub/marketplace/search
  query: q=string, platform=All|WAWUBasket|WAWUBeauty, category?
  response: { data: Product[], pagination }

GET  /api/hub/marketplace/seller/:wawuId/products
  -- used for the "Attach a product" picker in the Create sheet
  -- fetches the requesting user's own listings from Basket AND Beauty
  response: {
    WAWUBasket: Product[],
    WAWUBeauty: Product[]
  }
```

**Product object shape:**
```json
{
  "id": "string",
  "name": "Ground Egusi · 500g",
  "price": "₦4,500",
  "platform": "WAWUBasket|WAWUBeauty",
  "seller": { "name": "string", "tier": "business", "wawuId": "uuid" },
  "badge": null or "gold|black",
  "imageUrl": "string",
  "description": "string",
  "specs": [["Weight", "500g"], ["Origin", "Enugu, NG"]],
  "moreBySeller": Product[]
}
```

The hub's marketplace proxy calls:
- WAWUBasket: `GET /catalog/items` (already exists)
- WAWUBeauty: `GET /api/catalog/products/public` (new endpoint, see Stream 3)

---

### 3.6 PROFILE

```
GET  /api/hub/profile/me             — own profile
GET  /api/hub/profile/:wawuId        — other user's profile (public view only)
PATCH /api/hub/profile/me            — update profile
  body: { firstName, lastName, country, state, occupation, profileImage? }

GET  /api/hub/profile/me/posts       — my posts with status pills
GET  /api/hub/profile/me/activity    — my recent actions (votes, comments, saves)
GET  /api/hub/profile/me/saved       — my saved posts
GET  /api/hub/profile/me/orders      — orders from Basket + Beauty (aggregated)
GET  /api/hub/profile/me/courses     — enrolled courses (stored when user enrolls)

POST /api/hub/profile/:wawuId/follow  — follow a business (business/partner tier only)
DELETE /api/hub/profile/:wawuId/follow
```

**Own profile shape:**
```json
{
  "id": "uuid",
  "name": "David Adeyemi",
  "occupation": "Agripreneur",
  "country": "Lagos, Nigeria",
  "verificationTier": "basic",
  "trustScore": 820,
  "trustTier": "Gold",
  "trustBreakdown": {
    "earns": [
      { "label": "Course completion", "points": "+50" },
      { "label": "Purchase", "points": "+20" },
      { "label": "Helpful contribution", "points": "+10" },
      { "label": "Verified info", "points": "+30" }
    ],
    "loses": [
      { "label": "Spam", "points": "-100" },
      { "label": "Policy violation", "points": "-150" }
    ],
    "nextTierAt": 1500,
    "progressPercent": 54
  },
  "verificationStatus": {
    "current": "basic",
    "levels": [
      { "tier": "basic", "state": "current", "req": "Phone and email confirmed." },
      { "tier": "verified_user", "state": "next", "req": "Government ID + Face-ID liveness." },
      { "tier": "verified_business", "state": "locked", "req": "Business documents + website." },
      { "tier": "certified_professional", "state": "locked", "req": "Qualifications or licence." },
      { "tier": "trusted_partner", "state": "locked", "req": "Apply as a WAWU partner." }
    ]
  }
}
```

---

### 3.7 TRUST SCORE

```
GET  /api/hub/trust/me               — full breakdown (own only)
GET  /api/hub/trust/:wawuId          — public view: score + tier only
POST /api/hub/trust/events           — record a trust event (internal service calls)
  body: { userId, event: "course_completed|purchase|sale|helpful|positive_rating|verified_info|spam|fraud|false_info|offensive|violation" }
```

---

### 3.8 TRAINING

```
GET  /api/hub/training               — featured programme + future programmes
  response: {
    featured: {
      partner: "Alison",
      title: "Free certified courses for 10 million Africans",
      body: "string",
      pills: ["Free", "Certificate included"],
      enrollUrl: "https://alison.com/..."
    },
    comingSoon: []
  }

POST /api/hub/training/enroll        — record enrollment (for Trust Score + My Courses)
  body: { partner: "Alison", courseName: "string" }
```

---

### 3.9 SERVICES

```
GET  /api/hub/services               — all services list
GET  /api/hub/services/:id           — service detail (what, eligibility, steps)
GET  /api/hub/services/mentors       — mentor list
  query: expertise?, page=1

GET  /api/hub/services/mentors/:id   — mentor detail

POST /api/hub/services/mentors/:id/request
  body: { workingOn: string, supportNeeded: string, contactMethod: "WhatsApp|Email" }
  response: { message: "Request sent. We'll match you and follow up." }
```

---

### 3.10 KNOWLEDGE HUB + COUNTRY INSIGHTS

```
GET  /api/hub/knowledge              — featured article + all sections
GET  /api/hub/knowledge/:id          — article/report detail
GET  /api/hub/knowledge/playbook     — { downloadUrl: "signed-s3-url" }

GET  /api/hub/countries              — list of countries with last-updated
GET  /api/hub/countries/:name        — country detail with all 8 sections
```

---

### 3.11 ADMIN API

```
-- MODERATION QUEUE
GET    /api/admin/queue
  query: type=Opportunity|Event|Research|Business Listing|Partner Announcement, page=1
  response: { data: QueueItem[], counts: { Opportunities: 12, Events: 4, ... } }

PATCH  /api/admin/queue/:id/approve
PATCH  /api/admin/queue/:id/reject
  body: { reason: string (required) }

POST   /api/admin/queue/bulk-approve  body: { ids: string[] }
POST   /api/admin/queue/bulk-reject   body: { ids: string[], reason: string }

-- VERIFICATION REQUESTS
GET    /api/admin/verifications
PATCH  /api/admin/verifications/:id/approve
PATCH  /api/admin/verifications/:id/reject    body: { reason: string }
PATCH  /api/admin/verifications/:id/request-info  body: { message: string }

-- USERS
GET    /api/admin/users
  query: tier?, country?, status=Active|Suspended|Banned, joined_from?, joined_to?, page=1
GET    /api/admin/users/:id
PATCH  /api/admin/users/:id/suspend
PATCH  /api/admin/users/:id/ban
PATCH  /api/admin/users/:id/unsuspend
POST   /api/admin/users/:id/note    body: { note: string }

-- TRUST SCORE
GET    /api/admin/trust/leaderboard  query: page=1
POST   /api/admin/trust/:wawuId/adjust
  body: { delta: int (positive or negative), reason: string (required) }
  response: { newScore: int, newTier: string }

-- KNOWLEDGE HUB CONTENT
GET    /api/admin/content            query: type?, status=Published|Draft|Archived, page=1
POST   /api/admin/content
  body: { title, type, body, source, author, countryTags[], publishImmediately: bool }
PATCH  /api/admin/content/:id
DELETE /api/admin/content/:id        -- soft-delete (archived)

-- COUNTRY INSIGHTS
GET    /api/admin/countries
PATCH  /api/admin/countries/:name
  body: { sections: [{ title, content }] }

-- OPPORTUNITIES (admin view)
GET    /api/admin/opportunities      query: type?, country?, status?, page=1
POST   /api/admin/opportunities      -- admin-created, publishes immediately
PATCH  /api/admin/opportunities/:id
DELETE /api/admin/opportunities/:id

-- EVENTS
GET    /api/admin/events             query: type?, country?, status?, page=1
POST   /api/admin/events
PATCH  /api/admin/events/:id
  body: includes featured: bool (pin to Events landing top)
DELETE /api/admin/events/:id

-- ANALYTICS
GET    /api/admin/analytics
  response: {
    stats: { totalUsers: 24180, newThisWeek: 612, activeToday: 3940,
             pendingModeration: 35, opportunitiesThisMonth: 48, eventsThisMonth: 12 },
    growthSeries: [0.20, 0.22, ...],   -- 30 data points, normalised 0..1
    contentBars: [["Articles", 0.9], ...]
  }

GET    /api/admin/analytics/export
  query: type=users|content|opportunities|events|moderation_log|trust_audit, format=csv

-- ADVERTISEMENTS
GET    /api/admin/ads
POST   /api/admin/ads
  body: { advertiser, placement: "Feed pinned|Right rail|Popup", start, end, country, creativeUrl? }
PATCH  /api/admin/ads/:id
DELETE /api/admin/ads/:id

-- REPORTED CONTENT
GET    /api/admin/reported
PATCH  /api/admin/reported/:id/dismiss
PATCH  /api/admin/reported/:id/remove    -- removes the reported content

-- SELLERS (flagged product review)
GET    /api/admin/sellers            query: app=WAWUBasket|WAWUBeauty, page=1
GET    /api/admin/flagged-products
PATCH  /api/admin/flagged-products/:id/dismiss
PATCH  /api/admin/flagged-products/:id/remove

-- TRAINING + SERVICES
GET    /api/admin/training
PATCH  /api/admin/training/:id

GET    /api/admin/services
PATCH  /api/admin/services/:id
  body: { name?, provider?, tag?, what?, eligibility?, benefits?, steps?, status? }

-- MENTORS
GET    /api/admin/mentors
GET    /api/admin/mentor-requests    -- incoming mentorship requests for matching
PATCH  /api/admin/mentor-requests/:id/match  body: { mentorId, note? }

-- ANNOUNCEMENTS
GET    /api/admin/announcements
POST   /api/admin/announcements
  body: { title, audience, placement, start, end }
PATCH  /api/admin/announcements/:id
DELETE /api/admin/announcements/:id

-- TEAM / SETTINGS
GET    /api/admin/team
POST   /api/admin/team              body: { name, email, role }
DELETE /api/admin/team/:id

GET    /api/admin/settings
PATCH  /api/admin/settings          body: { key: string, value: bool }
```

---

## SECTION 4 — STREAM BREAKDOWN AND PHASED TASK MAPS

---

### STREAM 1 — WAWU ID SERVICE
**Repo:** New NestJS project (create on Railway)
**Design files needed:** `WAWUAfrica Onboarding.html` (auth screens reference)
**Blocks:** Every other stream depends on this being deployed

**First message to agent:**
> You are building WAWU ID — a new standalone NestJS authentication service
> deployed on Railway. This is the unified identity layer for the WAWUAfrica
> ecosystem. All other apps (WAWUAfrica hub, WAWUBeauty, WAWUBasket) will
> verify tokens issued by this service. Read the full spec in the attached
> brief before starting. Build phase by phase and wait for confirmation.

**Phase 1 — Scaffold + schema**
- `nest new wawu-id`
- Prisma + PostgreSQL setup
- `wawu_users` table migration (schema in Section 2)
- `refresh_tokens` table
- Health check endpoint `GET /health`
- Deploy to Railway, confirm DB connection
- **Deliverable:** Live URL, health check passes

**Phase 2 — Core auth**
- Register: POST /auth/register (email, phone, password, firstName, lastName, country)
- Login: POST /auth/login → {accessToken, refreshToken, user}
- Refresh: POST /auth/refresh
- JWKS: GET /.well-known/jwks.json (RS256 key pair, not HS256)
- JWT payload shape from Section 2
- **Deliverable:** Can register + login + get JWKS

**Phase 3 — OTP + password reset**
- OTP start: POST /auth/otp/start (sends via Termii or similar)
- OTP verify: POST /auth/otp/verify → tokens
- Forgot password: POST /auth/forgot-password (email link)
- Reset password: POST /auth/reset-password
- **Deliverable:** Full auth flow working

**Phase 4 — Provisioning**
- Internal export endpoint: GET /internal/users/export (service-key protected)
  This endpoint is on the WAWUAfrica backend — WAWU ID calls it.
  Add the import job: reads batches from WAWUAfrica export, creates wawu_users records
  using dedup logic from Section 2 (Categories A, B, C)
- Activation email job: queues emails for Category B users with one-time link
- POST /auth/activate (one-time token → set password)
- **Deliverable:** Provisioning job tested in staging

**Phase 5 — Internal admin endpoints**
- PATCH /internal/users/:id/trust-score (called by hub when trust events happen)
- PATCH /internal/users/:id/verification-tier (called by hub after admin approval)
- Both require service-key header, not user JWT
- **Deliverable:** Internal endpoints working, full service ready for other streams

---

### STREAM 2 — WAWU AFRICA BACKEND (cleanup + hub API)
**Repo:** `wawu-backend-pro`
**Design files needed:** ALL HTML files (for contract reference)
**Waits for:** WAWU ID live URL + JWKS URL + JWT payload shape

**First message to agent:**
> You are working on the WAWUAfrica backend (Laravel 10, MySQL). This codebase
> currently powers an onboarding pipeline for ~31,000 users and an EasyBuy
> submissions form. You are (1) removing dead V1 app code, (2) adding WAWU ID
> JWT middleware, and (3) building the hub API namespace. The onboarding and
> EasyBuy systems must NOT be touched. Build phase by phase. See the brief for
> full contracts.

**Phase 1 — Remove dead V1 code (routes disabled, code deleted, NO table drops)**
Remove routes and controllers for:
- Gigs, Portfolios, FAQs, Pricings (seller routes)
- Chat, ChatMessages, ChatParticipants (routes only — keep tables)
- Old Posts/PostCategories (the old V1 blog — keep table, will be replaced by hub_posts)
- Briefs, Lists (buyer routes)
- Old Products, ProductCategories (V1 ecommerce — keep tables)
- Old Orders, Cart, CartItem (V1 ecommerce)
- Subscriptions, PaymentPlans, PlanFeatures (old subscription system)
- YouTubeLinks, Ads (old platform content)
- V2 namespace entirely (all /api/v2/* routes and V2 controllers)
- Services marketplace (ServiceCategory, ServiceSubCategory, Services — the old freelance services, NOT the hub services hub)
- Mentors/Mentees (old mentorship — keep tables, hub has new mentorship)
Remove these files. Keep: all migrations, all onboarding files, EasyBuy files, User model, Country/State models, auth files, admin auth.
**Deliverable:** Clean routes/api.php, no dead imports, existing onboarding endpoints still work

**Phase 2 — WAWU ID middleware**
- Install `tymon/jwt-auth` or write custom RS256 JWT verification middleware
- Fetch WAWU ID JWKS on boot, cache public key
- `WawuIdAuth` middleware: verifies JWT, extracts user from `sub`, attaches to request
- Run ALONGSIDE existing Sanctum — both work during transition
- New hub routes use `WawuIdAuth`; old onboarding routes keep their existing auth
- **Deliverable:** `GET /api/hub/ping` returns 200 with valid WAWU ID JWT, 401 without

**Phase 3 — Hub migrations**
Create new tables (all prefixed `hub_`):
```sql
hub_posts (id, wawu_user_id, category, title, body, tags json, variant,
           product_ref json nullable, opportunity_meta json nullable,
           event_meta json nullable, status, rejection_reason, created_at)
hub_votes (id, wawu_user_id, hub_post_id, direction)
hub_saves (id, wawu_user_id, hub_post_id)
hub_comments (id, wawu_user_id, hub_post_id, parent_id nullable, body, created_at)
hub_opportunities (id, wawu_user_id, type, title, org, org_desc, location,
                   country, deadline, closing_soon, amount, eligibility,
                   description, criteria json, website, status,
                   rejection_reason, admin_verified, featured, created_at)
hub_events (id, wawu_user_id, name, org, org_bio, org_tier, format, type,
            location, address, month, day, dow, time, tz, date_actual,
            description, speakers json, url, going_count, featured,
            status, rejection_reason, is_past, created_at)
hub_going (id, wawu_user_id, hub_event_id)
hub_knowledge (id, category, title, source, author, org, body text,
               date_label, meta, file_url nullable, status, created_at)
hub_country_insights (id, country_name, sections json, updated_at)
hub_trust_events (id, wawu_user_id, event_type, delta, reason, created_at)
hub_user_profiles (id, wawu_user_id, occupation, interests json, follows json, created_at)
hub_follows (id, follower_wawu_id, followed_wawu_id)
hub_mentor_requests (id, requester_wawu_id, mentor_wawu_id, working_on,
                     support_needed, contact_method, status, admin_note)
hub_enrollments (id, wawu_user_id, partner, course_name, enrolled_at)
hub_applications (id, wawu_user_id, opportunity_id, name, email, phone,
                  country, motivation, document_url nullable, created_at)
hub_mentors (id, wawu_user_id, bio, expertise json, industries json,
             availability_label, status, created_at)
hub_services (id, slug, name, provider, icon, tag, what, eligibility json,
              benefits json, steps json, status, is_mentorship bool)
hub_knowledge_sections (id, title, sort_order)
hub_ads (id, advertiser, placement, start_date, end_date, country,
         creative_url nullable, status, created_at)
hub_announcements (id, title, audience, placement, start_date, end_date, status)
hub_moderation_log (id, admin_wawu_id, action, target_type, target_id,
                    reason nullable, created_at)
hub_trust_adjustments (id, admin_wawu_id, user_wawu_id, delta, reason, created_at)
hub_reported_content (id, reporter_wawu_id, content_type, content_id,
                      reason, status, reports_count, created_at)
```
**Deliverable:** All migrations run cleanly, `php artisan migrate` passes

**Phase 4 — Hub posts + feed API**
Build controllers matching contracts in Section 3.2:
- FeedController: index (with filter/country/following/page), show
- PostController: store, vote, save, comments index, comment store, reply store
Gated post types (Opportunity, Event, Research): set status='pending' on store
Auto-published: Learn, Sell, Question
**Deliverable:** Can create + read posts via API, votes + comments work

**Phase 5 — Opportunities API**
Section 3.3 contracts. Admin approval flow: submitted → pending → admin approves/rejects.
Expression of interest form submission stores to hub_applications.
**Deliverable:** Opportunities CRUD + apply endpoint

**Phase 6 — Events API**
Section 3.4 contracts. Going toggle updates going_count.
Past events: date_actual < now() automatically.
**Deliverable:** Events CRUD + going endpoint

**Phase 7 — Knowledge Hub + Country Insights API**
Section 3.10 contracts. Playbook returns a signed S3 URL.
**Deliverable:** Knowledge hub content endpoints + country endpoints

**Phase 8 — Marketplace proxy API**
Section 3.5 contracts. Hub calls Basket/Beauty APIs:
- Basket: GET `{BASKET_BASE_URL}/catalog/items` (already public)
- Beauty: GET `{BEAUTY_BASE_URL}/api/catalog/products/public` (new endpoint)
Hub aggregates and normalises to unified Product shape.
Cache responses for 5 minutes to avoid hammering satellite APIs.
**Deliverable:** Marketplace endpoints return real data from Basket + Beauty

**Phase 9 — Profile + Trust API**
Section 3.6 + 3.7. Orders aggregated by calling Basket + Beauty order history
endpoints with the user's platform IDs from their WAWU ID token.
Courses read from hub_enrollments.
**Deliverable:** Profile endpoints work, trust breakdown correct

**Phase 10 — Training + Services API**
Section 3.8 + 3.9. Services data seeded from hub_services.
Mentors managed via hub_mentors. Mentor requests → hub_mentor_requests.
**Deliverable:** Training + services endpoints work

**Phase 11 — Admin API**
Section 3.11. All admin endpoints. Admin auth uses existing Sanctum admin token.
Moderation queue reads all pending hub items across types.
Trust score adjustments call WAWU ID internal endpoint PATCH /internal/users/:id/trust-score.
Verification tier updates call WAWU ID PATCH /internal/users/:id/verification-tier.
**Deliverable:** Admin can approve/reject/manage all content types

**Phase 12 — Provisioning export endpoint**
GET /api/internal/users/export (service-key protected, not Sanctum, not WAWU ID JWT)
Returns paginated deduplicated users from both onboarding_submissions and users table.
Dedup logic from Section 2. Called by WAWU ID provisioning job.
**Deliverable:** WAWU ID can import users

---

### STREAM 3 — WAWUBEAUTY (catalog endpoint + WAWU ID)
**Repo:** `-ojaewa-pro-api`
**Design files needed:** `WAWUAfrica Onboarding.html` (login screen reference for auth UI change)
**Waits for:** WAWU ID live URL + JWKS URL

**First message to agent:**
> You are making two targeted changes to WAWUBeauty's Laravel 12 backend:
> (1) adding a public product catalog endpoint for the WAWUAfrica hub to read,
> (2) adding WAWU ID JWT verification middleware alongside existing Sanctum.
> You are also updating the auth UI to reflect WAWU ID unified login.
> Do not change any existing auth logic — run WAWU ID verification in parallel.

**Phase 1 — Public catalog endpoint**
New controller: `CatalogPublicController`
```
GET /api/catalog/products/public
  query: seller_id (WAWU user UUID — maps to beauty_user_id on WAWU ID),
         category?, page=1, per_page=20
  auth: none (public)
  response: { data: [{ id, name, price, currency, imageUrl, category,
              seller: { name, storeName, tier }, badge, status }] }
  filter: only active/published products
```

Also:
```
GET /api/catalog/products/public/:id   — single product detail (for hub product detail screen)
```

Seller lookup: WAWU ID JWT contains `platformRefs.beautyUserId` → use that to find the
seller's SellerProfile or BusinessProfile → return their products.
**Deliverable:** Endpoints tested and returning real Beauty products

**Phase 2 — WAWU ID middleware**
- Fetch JWKS from WAWU ID on boot, cache public key
- `WawuIdMiddleware`: verifies RS256 JWT, extracts user
- Apply to catalog endpoints that need auth (seller's OWN products, not public browse)
- Existing Sanctum middleware unchanged on all other routes
- **Deliverable:** Middleware working, existing routes unaffected

**Phase 3 — Auth UI update**
WAWUBeauty has a web and mobile frontend. This change is conceptual:
- Login screen: email+password form now submits to WAWU ID `/auth/login`
  instead of `/api/login` on Beauty backend. Response is a WAWU ID JWT.
- Beauty stores the WAWU ID JWT and uses it for all requests.
- Google OAuth: if Beauty frontend uses Google OAuth, pass the Google token
  to WAWU ID which handles it centrally.
- Add "Secured by WAWU ID" badge on the login screen (matches hub login screen design)
- NOTE: If Beauty frontend repo is not available, document this as a handoff
  note for the frontend team with exact API endpoint change required.
**Deliverable:** Auth flow documented; if frontend repo available, implemented

---

### STREAM 4 — WAWUBASKET (WAWU ID strategy + vendor endpoint)
**Repo:** `WAWUBasket-API`
**Design files needed:** `WAWUAfrica Onboarding.html` (login screen reference)
**Waits for:** WAWU ID live URL + JWKS URL

**First message to agent:**
> You are making two targeted changes to WAWUBasket's NestJS backend:
> (1) adding WAWU ID JWT as a second Passport strategy alongside existing JWT,
> (2) adding a vendor public products endpoint for the hub's "Attach a product" picker.
> Run WAWU ID auth alongside existing auth — do not replace existing auth yet.

**Phase 1 — Vendor public products endpoint**
```
GET /vendor/products/public
  query: wawu_id=string (WAWU ID UUID of the requesting user)
  auth: valid WAWU ID JWT OR valid existing Basket JWT
  response: { data: [{ id, name, price, imageUrl, category, status }] }
  filter: only published/active products for this vendor
  lookup: use platformRefs.basketUserId from WAWU ID JWT to find the User record
```
This is used by the hub when a user taps "Attach a product" — hub calls this
endpoint with the user's WAWU ID, gets back their Basket listings.
**Deliverable:** Endpoint returns vendor's active Basket products

**Phase 2 — WAWU ID Passport strategy**
- Add `WawuIdJwtStrategy` (passport-jwt, RS256, JWKS from WAWU ID)
- Register alongside existing `JwtStrategy`
- Guards can specify which strategy: `@UseGuards(AuthGuard(['jwt', 'wawu-id']))`
  — accepts either token format
- **Deliverable:** Basket endpoints accept both existing JWTs and WAWU ID JWTs

**Phase 3 — Auth UI update**
Basket uses phone OTP as primary auth. WAWU ID will handle this centrally.
Update:
- OTP start: call WAWU ID `POST /auth/otp/start` instead of local Basket OTP
- OTP verify: call WAWU ID `POST /auth/otp/verify` → get WAWU ID JWT
- Add email+password option: new "Sign in with email" button → WAWU ID login
- Login screen gets "One account for WAWUAfrica, Basket & Beauty" subtitle
- If Basket mobile frontend repo available: update auth flow there
- Document as handoff note for mobile team if not available
**Deliverable:** Auth flow documented and/or implemented

---

### STREAM 5 — NEXT.JS HUB FRONTEND
**Design files needed:** ALL HTML files + tokens.css
**Waits for:** Nothing (start immediately with mock data, wire APIs progressively)

**First message to agent:**
> You are building the WAWUAfrica hub frontend — a Next.js 14 App Router web
> application. All screens are designed in the attached HTML files. You build
> them phase by phase, starting with the design system. Use mock data from the
> design files initially; wire real API calls progressively as backends come
> online. Mobile-first, desktop-responsive. Read the full brief for contracts.

**Phase 1 — Project scaffold + design system**
- `npx create-next-app@14 wawuafrica-hub --typescript --tailwind --app`
- Tailwind config: map ALL tokens from `assets/tokens.css` to Tailwind theme
  ```
  Colors: bg, bg2, bgSoft, fgH, fg2, fgPh, fgDis, dark, divider, input, tag, error, success, warning, info
  Fonts: Inter (Google Fonts)
  Border radius, shadows, spacing from token values
  ```
- Base component library: translate `lib/kit.jsx` → React/TypeScript components
  Button, Icon, Field, TextInput, SelectInput, PhoneInput, OtpInput
- Layout components: StatusBar, BottomTabBar, DesktopShell (3-column)
- Trust components: VerificationBadge, TrustScoreChip, TrustMeter (from trust.jsx)
- Post components: PostCard, CategoryTag, HandoffPill, ActionRow, ShareSheet (from posts.jsx)
- **Deliverable:** Design system renders correctly, Storybook or dev page showing all components

**Phase 2 — Auth screens (WAWU ID)**
From `WAWUAfrica Onboarding.html`. Wire against WAWU ID endpoints.
Screens: Splash → SignUp → OTP → BasicAchieved → Interests → Welcome → Login
Auth state: store WAWU ID JWT in httpOnly cookie (Next.js middleware for SSR auth)
Refresh token flow: automatic silent refresh
**Deliverable:** Full auth flow working against live WAWU ID

**Phase 3 — Home + feed**
From `WAWUAfrica Feed.html`. Wire against hub posts/feed API.
Mock data shape from `lib/feed-data.jsx`. All post card variants, create sheet,
7 category forms, product attach picker, pending states.
**Deliverable:** Feed renders with real posts, create works

**Phase 4 — Profile + trust**
From `WAWUAfrica Profile.html`. Wire against profile + trust APIs.
Own profile vs other profile modes. Verification upgrade CTA → links to WAWU ID
verification flow.
**Deliverable:** Profile screens working

**Phase 5 — Marketplace**
From `WAWUAfrica Marketplace.html`. Wire against marketplace proxy API.
Product cards, Basket section, Beauty section, search, AI Basket Builder UI (static).
**Deliverable:** Marketplace browsing working

**Phase 6 — Opportunities**
From `WAWUAfrica Opportunities.html`. Wire against opportunities API.
Jobs filter → Coming Soon panel. Expression of interest form.
**Deliverable:** Opportunities browsing + applying working

**Phase 7 — Training + Services**
From `WAWUAfrica Training-Services.html`. Wire against training + services API.
Alison handoff confirmation sheet. Mentor list + request flow.
**Deliverable:** Training + services screens working

**Phase 8 — Knowledge Hub + Events**
From `WAWUAfrica Knowledge.html` + `WAWUAfrica Events.html`.
Wire against knowledge + events API. Going toggle.
**Deliverable:** Knowledge hub + events working

**Phase 9 — Admin dashboard**
From `WAWUAfrica Admin.html`. Wire against admin API.
Admin-only route guard. Desktop-first layout. Full moderation queue, side panel,
verification requests, users, trust, content, analytics.
**Deliverable:** Admin dashboard fully functional

**Phase 10 — Integration pass + polish**
- Replace all remaining mock data with real API calls
- Error states, loading states, empty states throughout
- SEO metadata (Next.js generateMetadata)
- PWA manifest for mobile installability
- Performance: image optimisation, lazy loading, prefetch
- **Deliverable:** Production-ready, all screens wired

---

## SECTION 5 — WHAT EACH AGENT GETS AS THEIR FIRST MESSAGE

Each agent needs these artifacts at the start of their session. Include all of these:

**Every agent:**
- This brief document (WAWUAfrica_Master_Build_Brief.md)
- The relevant repo link(s) with PAT

**Stream 1 (WAWU ID):**
- `WAWUAfrica Onboarding.html`

**Stream 2 (WAWUAfrica backend):**
- All 10 HTML design files
- WAWUAfrica_Design_Handoff.md

**Stream 3 (WAWUBeauty):**
- `WAWUAfrica Onboarding.html`

**Stream 4 (WAWUBasket):**
- `WAWUAfrica Onboarding.html`

**Stream 5 (frontend):**
- All 10 HTML design files
- `assets/tokens.css`
- WAWUAfrica_Design_Handoff.md

---

## SECTION 6 — INFORMATION FLOW BETWEEN STREAMS

Stream 1 → produces → **WAWU ID Contract Card**:
```
WAWU_ID_BASE_URL: https://wawu-id.railway.app
JWKS_URL: https://wawu-id.railway.app/.well-known/jwks.json
JWT_ALGORITHM: RS256
JWT_PAYLOAD_SHAPE: { sub, email, phone, firstName, lastName, country,
                     verificationTier, trustScore, status, platformRefs }
INTERNAL_SERVICE_KEY: [generated secret, share securely]
```
Share this with Streams 2, 3, 4, and 5 before they start auth wiring.

Stream 2 → produces → **Hub API Base URL** → share with Stream 5 for API wiring.

Stream 3 → produces → **Beauty Catalog URL** → share with Stream 2
(Stream 2 needs this to configure the marketplace proxy).

Stream 4 → produces → **Basket Vendor Products URL** → share with Stream 2.

---

## SECTION 7 — WHAT NOT TO TOUCH

**WAWUAfrica backend — never modify:**
- `database/migrations/2026_*` (all onboarding migrations)
- `app/Http/Controllers/OnboardingSubmissionController.php` and all onboarding controllers
- `app/Http/Controllers/EasyBuySubmissionController.php`
- `routes/api.php` onboarding routes (lines 405–415)
- `app/Models/OnboardingSubmission.php` and all Onboarding* models
- `config/onboarding.php`, `config/easybuy.php`
- Any VFD or bank provisioning code
- `database/seeders` that touch onboarding data
- The `onboarding_submissions`, `onboarding_pre_registrations`, `easy_buy_submissions`
  tables and their related tables — DO NOT DROP, DO NOT ALTER

**WAWUBasket — never modify:**
- Existing order/payment/delivery flows
- Rider/driver modules
- Existing user auth (only ADD WAWU ID alongside it)

**WAWUBeauty — never modify:**
- Existing checkout/payment flows
- Existing order management
- Existing user auth (only ADD WAWU ID alongside it)

