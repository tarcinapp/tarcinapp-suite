# 40_EXAMPLE_books-app.md

## Overview

This walkthrough builds a complete books application on Tarcinapp from zero. At the end, you'll have:

- `GET /api/v1/books` — list books
- `POST /api/v1/books` — create a book
- `GET /api/v1/books/{id}/chapters` — get sub-chapters of a book
- `GET /api/v1/shelves` — list bookshelves
- `POST /api/v1/shelves/{id}/entities/books` — add a book to a shelf
- `GET /api/v1/shelves/{id}/entities/books` — list books in a shelf
- `GET /api/v1/books/{id}/reactions/reviews` — get reviews for a book
- `POST /api/v1/books/{id}/reactions/reviews` — write a review

All via configuration — zero backend code.

---

## Domain Design

| Business concept | Record type | `_kind` value |
|:---|:---|:---|
| Book | Entity | `book` |
| Chapter | Entity (child of book) | `chapter` |
| Author | Entity | `author` |
| Bookshelf | List | `shelf` |
| Review | Entity Reaction | `review` |
| Rating | Entity Reaction | `rating` |

### Design Decisions

**Why is `chapter` an Entity (not a List)?**

`chapter` uses the Entity record type and is connected to its parent book via the Entity **hierarchy** mechanism (`_parents` array). Hierarchy is the right choice when:
- The child is the **same conceptual record type** as the parent (both are "content records")
- The relationship is **containment** — a chapter belongs to one book, it does not have its own identity independent of that book
- You want `GET /api/v1/books/{id}/chapters` to be the natural access path

This is different from a **List → Entity relation** (`ListEntityRelation`), which models a *membership* or *collection* relationship where an entity can belong to many lists (e.g., a book belonging to multiple shelves). Hierarchy via `_parents` models ownership and containment within the same record type; list-entity relations model many-to-many collection membership across record types.

**Why is `author` its own Entity?**

`author` could be stored as a plain string field on `book` (e.g., `"author": "Leo Tolstoy"`). However, modeling it as a separate Entity record allows:
- Rich author profiles (birth year, country, biography)
- Reuse across books
- Cross-linking via a `tapp://` URI reference in the `author` field

When the `author` field on a book contains a `tapp://localhost/entity/{uuid}` URI, the orchestrator layer can dereference it to enrich the book with data from the author record (e.g., copying `country` onto the book). This is exactly what `42_EXAMPLE_custom-business-logic.md` demonstrates.

---

## Step 1: Configure entity-persistence-service

Set environment variables (or `.env` file):

```bash
# Allowed kinds
ENTITY_KINDS=book,chapter,author
LIST_KINDS=shelf
LIST_ENTITY_REL_KINDS=book-in-shelf
ENTITY_REACTION_KINDS=review,rating,like

# Auto-approve — global defaults
AUTOAPPROVE_ENTITY=false              # books and chapters need admin approval by default
AUTOAPPROVE_LIST=true                 # shelves are immediately active
AUTOAPPROVE_LIST_ENTITY_RELATIONS=true
AUTOAPPROVE_ENTITY_REACTION=false     # global default: reviews not auto-approved

# Per-kind auto-approve overrides
# Reviews should go live immediately without admin action
AUTOAPPROVE_ENTITY_FOR_REVIEW=true

# Visibility defaults — global
VISIBILITY_ENTITY=private             # new books are private until published
VISIBILITY_LIST=protected             # shelves visible to friends
VISIBILITY_ENTITY_REACTION=private    # global default

# Per-kind visibility overrides
# Reviews are public so any authenticated user can read them
VISIBILITY_ENTITY_FOR_REVIEW=public

# Uniqueness: no duplicate book titles per user (same slug + kind + creator)
ENTITY_UNIQUENESS='where[_kind]=${_kind}&where[_slug]=${_slug}&where[_createdBy]=${_createdBy}'

# Response limits (max records returned per query)
RESPONSE_LIMIT_ENTITY=50
RESPONSE_LIMIT_LIST=100
RESPONSE_LIMIT_ENTITY_REACTION=100

# Record limits: max 100 books per user, max 1 review per user per 30 days
ENTITY_RECORD_LIMITS='[{"scope":"where[_kind]=book","limit":100},{"scope":"where[_kind]=review","limit":1,"duration":"30d"}]'
```

### Note on Per-Kind Record Limits

The `ENTITY_RECORD_LIMITS` `scope` filter applies globally for that user — `"scope":"where[_kind]=review"` limits a user to 1 review **across all books** per 30 days, not 1 review *per book*. If you need per-user-per-book uniqueness (one review per user per book), use the **uniqueness constraint** instead:

```bash
ENTITY_REACTION_UNIQUENESS='where[_kind]=${_kind}&where[_entityId]=${_entityId}&where[_createdBy]=${_createdBy}'
```

This prevents a user from submitting a second review on the same book entirely. The record limit with `duration` is appropriate for rate-limiting across all entities (e.g., "no more than 1 new review per day globally"), not for per-entity uniqueness.

---

## Step 2: Configure entity-persistence-gateway

Environment variables:

```bash
APP_NAME=books-app
APP_SHORTCODE=books               # roles will be: books.admin, books.member, etc.
APP_INBOUND_PORT=8081
APP_INBOUND_BASEURI=/api/v1/

# Backend (EPS)
APP_BACKEND_HOST=entity-persistence-service
APP_BACKEND_PORT=3000

# OPA
APP_OPA_HOST=entity-persistence-gateway-policies
APP_OPA_PORT=8181

# Auth
APP_AUTH_RS256PUBLICKEY=<your RS256 PEM public key>
APP_AUTH_ISSUER=https://auth.example.com/realms/books-app
APP_AUTH_CLOCKSKEWSECONDS=60

# Redis
SPRING_REDIS_HOST=redis
SPRING_REDIS_PORT=6379

# Kind aliases — books (entity) with chapters as hierarchy children
APP_KINDALIASPATHS_0_ALIAS=books
APP_KINDALIASPATHS_0_NAME=book
APP_KINDALIASPATHS_0_HIERARCHYALIAS=chapters
APP_KINDALIASPATHS_0_HIERARCHYNAME=chapter

APP_KINDALIASPATHS_1_ALIAS=shelves
APP_KINDALIASPATHS_1_NAME=shelf

APP_KINDALIASPATHS_2_ALIAS=authors
APP_KINDALIASPATHS_2_NAME=author

APP_KINDALIASPATHS_3_ALIAS=reviews
APP_KINDALIASPATHS_3_NAME=review

APP_KINDALIASPATHS_4_ALIAS=ratings
APP_KINDALIASPATHS_4_NAME=rating

# JSON Schema for books — validates POST /books and PUT/PATCH /books/{id}
# additionalProperties: false prevents callers from storing arbitrary fields
APP_KINDALIASPATHS_0_SCHEMA={"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"author":{"type":"string","minLength":1,"description":"Author name or tapp:// URI to an author entity"},"isbn":{"type":"string","pattern":"^[0-9-]{10,17}$","description":"ISBN-10 or ISBN-13"},"genre":{"type":"string","enum":["Fiction","Non-Fiction","Historical Fiction","Science Fiction","Biography","Other"]},"pages":{"type":"integer","minimum":1,"maximum":10000},"language":{"type":"string","default":"en"},"publishedYear":{"type":"integer","minimum":1000,"maximum":2100}},"required":["author"],"additionalProperties":false}

# JSON Schema for chapters (no author required, just a name and order)
# Chapters are created via POST /books/{id}/chapters so schema is simpler
APP_KINDALIASPATHS_0_HIERARCHYSCHEMA={"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"orderIndex":{"type":"integer","minimum":1},"summary":{"type":"string","maxLength":2000}},"additionalProperties":false}

# JSON Schema for reviews
APP_KINDALIASPATHS_3_SCHEMA={"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"rating":{"type":"integer","minimum":1,"maximum":5},"body":{"type":"string","minLength":10,"maxLength":5000},"spoiler":{"type":"boolean","default":false}},"required":["rating","body"],"additionalProperties":false}

# Saved queries
APP_QUERIES_MY="'sets[owners][userIds]='+#userId"
APP_QUERIES_ACTIVES="'sets[actives]'"
APP_QUERIES_BY_AUTHOR="'filter[where][author]='+#query['author-name']"
APP_QUERIES_BY_GENRE="'filter[where][genre]='+#query['genre']"

# Field sets
APP_FIELDSETS_SUMMARY_SHOW=_id,_name,_slug,author,genre,_visibility,_validFromDateTime
APP_FIELDSETS_DETAIL_SHOW=_id,_name,_slug,author,isbn,genre,pages,language,publishedYear,_visibility,_createdDateTime,_lastUpdatedDateTime

# Default fieldset — applies to ALL entity GETs unless caller specifies ?fieldset=
# NOTE: this is a global default; there is currently no per-kind default fieldset.
# If a specific route needs a different default, the caller must pass ?fieldset=detail explicitly.
APP_DEFAULTFIELDSET_ENTITIES=summary

# Disable generic routes — expose only the domain-specific API surface
APP_ROUTES_TAGS_DISABLED=generic

# Rate limiting for book creation (5 books/sec sustained, burst of 10)
APP_KINDALIASPATHS_0_RATELIMITER_REPLENISHRATE=5
APP_KINDALIASPATHS_0_RATELIMITER_BURSTCAPACITY=10
```

### Notes on the JSON Schema

- **`additionalProperties: false`** is strongly recommended for production. Without it, callers can inject any field name into stored records, which pollutes the database and can cause unexpected behavior (e.g., a caller storing a field named `_validFromDateTime` that bypasses the managed-field injections at the gateway layer — note that the gateway strips managed fields from payloads, but defense-in-depth is good practice).
- The **genre enum** constrains values to a controlled vocabulary. Change or extend this list in the schema to match your domain.
- **`APP_DEFAULTFIELDSET_ENTITIES=summary`** applies to all entity GETs across the entire gateway instance. There is no per-kind default fieldset configuration currently. If the `books` endpoint should return summary fields by default but `authors` should return detail fields, the caller must specify `?fieldset=detail` for authors explicitly.

---

## Step 3: Set Up Keycloak Roles

### Roles to Create

In Keycloak, create the following roles and assign them to users:

| Role | Who gets it |
|:---|:---|
| `books.admin` | Administrators — full access, can set managed fields, bypass restrictions |
| `books.editor` | Editors — can create and update records, set `_validFromDateTime` for scheduled publishing |
| `books.member` | Registered users — can create and own their content, read public/active records |
| `books.visitor` | Anonymous or unverified users — read-only access to public + active records |

### Token Mapper Configuration (Critical)

By default, Keycloak places roles in `realm_access.roles` inside the JWT. The Tarcinapp gateway expects roles as a **flat string array at the root** of the token, at the claim key `roles`. Without the mapper, roles are invisible to the gateway and all users are treated as unauthenticated.

**Configure the roles mapper in Keycloak:**

1. Navigate to: **Realm → Client Scopes → (your client scope, e.g. `books-app`) → Mappers → Add mapper → By Configuration**
2. Select mapper type: **"User Realm Role"**
3. Set:
   - **Name:** `roles`
   - **Token Claim Name:** `roles`
   - **JSON Type:** `String`
   - **Multivalued:** `ON` (this produces a JSON array, not a single string)
   - **Add to ID token:** `ON`
   - **Add to access token:** `ON`
4. Save.

This produces a token where `roles` appears at the root as a string array:
```json
{
  "sub": "user-uuid",
  "iss": "https://auth.example.com/realms/books-app",
  "roles": ["books.member"],
  "groups": ["/premium-readers"],
  ...
}
```

**Configure the groups mapper (for group-based ownership):**

1. In the same Client Scope → Mappers → Add mapper → By Configuration
2. Select mapper type: **"Group Membership"**
3. Set:
   - **Name:** `groups`
   - **Token Claim Name:** `groups`
   - **Full group path:** `ON` (produces `/group-name` with the leading slash)
   - **Add to access token:** `ON`
4. Save.

> **Note on the leading slash:** Keycloak emits groups as `"/premium-readers"` (with a leading `/`). The OPA policies in `entity-persistence-gateway-policies` handle this by normalizing or expecting the leading slash when comparing against `_ownerGroups`. If you store `"/premium-readers"` in `_ownerGroups`, the match works. Be consistent: never mix slashed and unslashed values in the same deployment.

### Field-Level Role for Scheduled Publishing

By default, members cannot set `_validFromDateTime` — doing so would let them self-approve content. If you have trusted editors who need to schedule future publication dates, create the following role in Keycloak and assign it to them:

```
books.fields.entities._validFromDateTime.create
```

This is a **field-level skeleton key** role. It removes `_validFromDateTime` from the member's forbidden-fields list **only for create operations**, without elevating them to full editor access. See `12_COMPONENT_gateway-policies.md` for the full field-level role syntax.

---

## Step 4: Test the API

### Create a book (as member)
```bash
TOKEN="eyJhbGci..."

curl -X POST http://localhost:8081/api/v1/books \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "_name": "War and Peace",
    "author": "Leo Tolstoy",
    "isbn": "978-0-14-028723-0",
    "genre": "Historical Fiction",
    "pages": 1225
  }'
```

**What the gateway does:**
1. Validates JWT → extracts `sub=user-uuid`, `roles=["books.member"]`
2. Checks OPA: member can create entities → `allow=true`
3. Validates payload against books JSON Schema → `author` present, `pages` is integer, no extra fields → passes
4. Injects `_kind=book` into payload
5. Injects `_createdBy=user-uuid`, `_ownerUsers=["user-uuid"]`, `_createdDateTime=now`
6. `_validFromDateTime` is NOT set (member cannot set it; auto-approve is false for books) → book is **PENDING**
7. `_visibility=private` (default from EPS config)
8. Proxies to EPS `POST /entities`

**Response (HTTP 201):**
```json
{
  "_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "_name": "War and Peace",
  "_kind": "book",
  "_slug": "war-and-peace",
  "_visibility": "private",
  "_validFromDateTime": null,
  "_validUntilDateTime": null,
  "_ownerUsers": ["user-uuid-1234"],
  "_ownerGroups": [],
  "_viewerUsers": [],
  "_viewerGroups": [],
  "_createdBy": "user-uuid-1234",
  "_createdDateTime": "2024-11-01T10:00:00.000Z",
  "_lastUpdatedDateTime": "2024-11-01T10:00:00.000Z",
  "_lastUpdatedBy": "user-uuid-1234",
  "_version": 1,
  "author": "Leo Tolstoy",
  "isbn": "978-0-14-028723-0",
  "genre": "Historical Fiction",
  "pages": 1225
}
```

> The `_validFromDateTime: null` means this record is **pending**. It is only visible to the owner (`_ownerUsers`) and admin/editor roles.

---

### Approve the book (as admin)
```bash
ADMIN_TOKEN="eyJhbGci..."

curl -X PATCH http://localhost:8081/api/v1/books/a1b2c3d4-e5f6-7890-abcd-ef1234567890 \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "_validFromDateTime": "2024-11-01T10:00:00.000Z",
    "_visibility": "public"
  }'
```

**Response (HTTP 200):**
```json
{
  "_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "_name": "War and Peace",
  "_kind": "book",
  "_slug": "war-and-peace",
  "_visibility": "public",
  "_validFromDateTime": "2024-11-01T10:00:00.000Z",
  "_validUntilDateTime": null,
  "_ownerUsers": ["user-uuid-1234"],
  "_ownerGroups": [],
  "_viewerUsers": [],
  "_viewerGroups": [],
  "_createdBy": "user-uuid-1234",
  "_createdDateTime": "2024-11-01T10:00:00.000Z",
  "_lastUpdatedDateTime": "2024-11-01T10:05:00.000Z",
  "_lastUpdatedBy": "admin-uuid-9999",
  "_version": 2,
  "author": "Leo Tolstoy",
  "isbn": "978-0-14-028723-0",
  "genre": "Historical Fiction",
  "pages": 1225
}
```

After this, the book is **active** and **public** — visible to all authenticated users.

---

### List active public books (summary fieldset)
```bash
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8081/api/v1/books?q=actives&fieldset=summary"
```

**Response (HTTP 200):**
```json
[
  {
    "_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "_name": "War and Peace",
    "_slug": "war-and-peace",
    "_visibility": "public",
    "_validFromDateTime": "2024-11-01T10:00:00.000Z",
    "author": "Leo Tolstoy",
    "genre": "Historical Fiction"
  }
]
```

> Only the fields in `APP_FIELDSETS_SUMMARY_SHOW` are returned. The gateway applies the `summary` fieldset because `APP_DEFAULTFIELDSET_ENTITIES=summary` is set.

---

### List active books with pagination
```bash
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8081/api/v1/books?q=actives&limit=10&skip=20"
```

This returns records 21–30 of the active books set. Useful for paginating large collections.

---

### List my books (including pending and private)
```bash
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8081/api/v1/books?q=my"
```

The gateway expands `q=my` to `sets[owners][userIds]={sub}` before forwarding to EPS. This returns all books owned by the caller, regardless of their `_validFromDateTime` or `_visibility` state — pending and private books are included.

---

### List books in a shelf
```bash
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8081/api/v1/shelves/shelf-uuid-5678.../entities/books"
```

**Response (HTTP 200):**
```json
[
  {
    "_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "_name": "War and Peace",
    "_slug": "war-and-peace",
    "_visibility": "public",
    "_validFromDateTime": "2024-11-01T10:00:00.000Z",
    "author": "Leo Tolstoy",
    "genre": "Historical Fiction"
  }
]
```

This is a **traversal route** — the gateway resolves all `book-in-shelf` relation records for this shelf, then fetches the corresponding book entities and returns them as a list.

---

### Get book detail (full fieldset)
```bash
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8081/api/v1/books/a1b2c3d4-e5f6-7890-abcd-ef1234567890?fieldset=detail"
```

Pass `?fieldset=detail` explicitly to override the global `summary` default and get all fields defined in `APP_FIELDSETS_DETAIL_SHOW`.

---

### Search by author (saved query)
```bash
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8081/api/v1/books?q=by-author&author-name=Tolstoy"
```

The gateway expands this to `filter[where][author]=Tolstoy` before calling EPS.

---

### Search by genre (saved query)
```bash
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8081/api/v1/books?q=by-genre&genre=Historical+Fiction"
```

The gateway expands this to `filter[where][genre]=Historical Fiction`.

---

### Create a chapter (child entity via hierarchy)
```bash
curl -X POST "http://localhost:8081/api/v1/books/a1b2c3d4-e5f6-7890-abcd-ef1234567890/chapters" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "_name": "Part One: Peace",
    "orderIndex": 1,
    "summary": "The Rostov and Bolkonsky families prepare for Napoleon'"'"'s invasion."
  }'
```

**Response (HTTP 201):**
```json
{
  "_id": "c9d8e7f6-a5b4-3210-fedc-ba9876543210",
  "_name": "Part One: Peace",
  "_kind": "chapter",
  "_slug": "part-one-peace",
  "_visibility": "private",
  "_validFromDateTime": null,
  "_validUntilDateTime": null,
  "_parents": ["a1b2c3d4-e5f6-7890-abcd-ef1234567890"],
  "_ownerUsers": ["user-uuid-1234"],
  "_createdBy": "user-uuid-1234",
  "_createdDateTime": "2024-11-01T11:00:00.000Z",
  "_lastUpdatedDateTime": "2024-11-01T11:00:00.000Z",
  "_version": 1,
  "orderIndex": 1,
  "summary": "The Rostov and Bolkonsky families prepare for Napoleon's invasion."
}
```

Note the `_parents` array contains the parent book's `_id`. This is how the hierarchy is stored — EPS uses `_parents` to resolve `GET /books/{id}/chapters` queries.

---

### Get chapters of a book
```bash
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8081/api/v1/books/a1b2c3d4-e5f6-7890-abcd-ef1234567890/chapters"
```

**Response (HTTP 200):**
```json
[
  {
    "_id": "c9d8e7f6-a5b4-3210-fedc-ba9876543210",
    "_name": "Part One: Peace",
    "_kind": "chapter",
    "_slug": "part-one-peace",
    "_parents": ["a1b2c3d4-e5f6-7890-abcd-ef1234567890"],
    "orderIndex": 1,
    "summary": "The Rostov and Bolkonsky families prepare for Napoleon's invasion."
  }
]
```

---

### Create a shelf and add a book to it
```bash
# 1. Create shelf
curl -X POST http://localhost:8081/api/v1/shelves \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"_name": "My Favorites"}'
```

**Response (HTTP 201):**
```json
{
  "_id": "shelf-uuid-5678-abcd-ef12",
  "_name": "My Favorites",
  "_kind": "shelf",
  "_slug": "my-favorites",
  "_visibility": "protected",
  "_validFromDateTime": "2024-11-01T12:00:00.000Z",
  "_ownerUsers": ["user-uuid-1234"],
  "_createdBy": "user-uuid-1234",
  "_createdDateTime": "2024-11-01T12:00:00.000Z",
  "_version": 1
}
```

> Shelves have `AUTOAPPROVE_LIST=true`, so `_validFromDateTime` is automatically set on creation.

```bash
# 2. Add book to shelf (creates a ListEntityRelation record)
curl -X POST "http://localhost:8081/api/v1/shelves/shelf-uuid-5678-abcd-ef12/entities/books" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "_entityId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "addedNote": "A masterpiece"
  }'
```

**Response (HTTP 201):**
```json
{
  "_id": "rel-uuid-1111-2222-3333",
  "_kind": "book-in-shelf",
  "_listId": "shelf-uuid-5678-abcd-ef12",
  "_entityId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "_validFromDateTime": "2024-11-01T12:01:00.000Z",
  "_createdBy": "user-uuid-1234",
  "_createdDateTime": "2024-11-01T12:01:00.000Z",
  "_version": 1,
  "addedNote": "A masterpiece"
}
```

---

### Write a review
```bash
curl -X POST "http://localhost:8081/api/v1/books/a1b2c3d4-e5f6-7890-abcd-ef1234567890/reactions/reviews" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "rating": 5,
    "body": "One of the greatest novels ever written. Tolstoy captures the full sweep of human experience.",
    "spoiler": false
  }'
```

**Response (HTTP 201):**
```json
{
  "_id": "rev-uuid-aaaa-bbbb-cccc",
  "_kind": "review",
  "_entityId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "_visibility": "public",
  "_validFromDateTime": "2024-11-01T13:00:00.000Z",
  "_ownerUsers": ["user-uuid-1234"],
  "_createdBy": "user-uuid-1234",
  "_createdDateTime": "2024-11-01T13:00:00.000Z",
  "_version": 1,
  "rating": 5,
  "body": "One of the greatest novels ever written. Tolstoy captures the full sweep of human experience.",
  "spoiler": false
}
```

> Reviews have `AUTOAPPROVE_ENTITY_FOR_REVIEW=true` and `VISIBILITY_ENTITY_FOR_REVIEW=public`, so they are immediately active and public.

---

### Get reviews for a book
```bash
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8081/api/v1/books/a1b2c3d4-e5f6-7890-abcd-ef1234567890/reactions/reviews?q=actives"
```

**Response (HTTP 200):**
```json
[
  {
    "_id": "rev-uuid-aaaa-bbbb-cccc",
    "_kind": "review",
    "_entityId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "_visibility": "public",
    "_validFromDateTime": "2024-11-01T13:00:00.000Z",
    "_createdBy": "user-uuid-1234",
    "_createdDateTime": "2024-11-01T13:00:00.000Z",
    "rating": 5,
    "body": "One of the greatest novels ever written. Tolstoy captures the full sweep of human experience.",
    "spoiler": false
  }
]
```

---

## Step 5: What the GUI Renders

Start `tarcinapp-base-gui` and connect it to `http://localhost:8081` with a valid Bearer token. The GUI fetches `GET /openapi.json` from the gateway (with the token) and builds the entire interface from it. With `APP_ROUTES_TAGS_DISABLED=generic`, only the domain-specific routes appear.

### Sidebar Entries

| Sidebar label | Record type | Notes |
|:---|:---|:---|
| Books | entity | Main books grid |
| Chapters | entity | Appears as a child entry under Books |
| Authors | entity | Independent entity grid |
| Shelves | list | Shelf management |
| Reviews | entity-reaction | Reaction grid |
| Ratings | entity-reaction | Reaction grid |

**Why "Chapters" appears under "Books" in the sidebar:**
The hierarchy alias `chapters` is configured on the `books` kind alias (`APP_KINDALIASPATHS_0_HIERARCHYALIAS=chapters`). The gateway embeds the chapters path (`/books/{id}/chapters`) as a sub-path of books in the OAS spec. The GUI's `oasParser.js` detects paths matching `/{param}/subResource` under the books tag and renders them as child navigation items. From the Books detail view, users see a "Chapters" tab that lists `GET /books/{id}/chapters` for the selected book.

### Create Form for Books

The form shows: `_name` (required), `author` (required by schema), `isbn`, `genre` (dropdown from enum), `pages`, `language`, `publishedYear`. It does **not** show `_ownerUsers`, `_createdBy`, or `_validFromDateTime` — the member's OPA policy marks those as forbidden for create operations, so they are stripped from the POST schema in the personalized OAS spec. Admins see a different form that includes the managed fields.

### "Add to Shelf" Flow in the GUI

1. Navigate to **Shelves** in the sidebar → see the shelves data grid.
2. Click a shelf row to open the shelf detail view.
3. The detail view shows a **Books** sub-resource tab (this is the `GET /shelves/{id}/entities/books` traversal route configured via `through.entities`).
4. Click **Add** → a form appears to enter the `_entityId` of the book and an optional `addedNote`.
5. On submit, the GUI calls `POST /shelves/{id}/entities/books` which creates the `ListEntityRelation` record.

This traversal navigation is derived from the OAS spec paths — the GUI discovers it automatically without any custom frontend code.

### Role-Aware UI

The GUI implements zero client-side access control. The gateway generates a **personalized OAS spec** for each authenticated user based on their roles and active OPA policies:
- A **visitor** only sees read-only grids with no Create/Edit/Delete buttons
- A **member** sees Create and Edit buttons for their own records, no `_validFromDateTime` field in forms
- An **admin** sees all fields including managed fields, approval controls, and Delete buttons

Updating a user's Keycloak role is immediately reflected in the UI on the next page load (which re-fetches the OAS spec).

---

## Step 6: Search by Author

With the saved query `APP_QUERIES_BY_AUTHOR` configured:

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8081/api/v1/books?q=by-author&author-name=Tolstoy"
```

The gateway expands this to `filter[where][author]=Tolstoy` before calling EPS.

The query supports partial string matching if EPS is configured for it (e.g., using `filter[where][author][like]=Tolstoy%`). In that case, update the saved query to include the `like` modifier:

```bash
APP_QUERIES_BY_AUTHOR="'filter[where][author][like]='+#query['author-name']+'%'"
```

---

## Step 7: End-to-End Flow — Putting It All Together

This section walks through the complete lifecycle: member creates a book → admin approves it → member adds it to a shelf → another user writes a review → admin views everything via the GUI.

### 7.1 Member Registers and Creates a Book

**Member (Alice) creates a book:**
```bash
ALICE_TOKEN="eyJhbGci..."   # token with roles=["books.member"], sub="alice-uuid"

curl -X POST http://localhost:8081/api/v1/books \
  -H "Authorization: Bearer $ALICE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "_name": "Anna Karenina",
    "author": "Leo Tolstoy",
    "isbn": "978-0-14-303500-9",
    "genre": "Fiction",
    "pages": 864
  }'
```

**Response (HTTP 201):**
```json
{
  "_id": "book-anna-uuid-1111",
  "_name": "Anna Karenina",
  "_kind": "book",
  "_slug": "anna-karenina",
  "_visibility": "private",
  "_validFromDateTime": null,
  "_ownerUsers": ["alice-uuid"],
  "_createdBy": "alice-uuid",
  "_createdDateTime": "2024-11-15T09:00:00.000Z",
  "_version": 1,
  "author": "Leo Tolstoy",
  "isbn": "978-0-14-303500-9",
  "genre": "Fiction",
  "pages": 864
}
```

**State:** Book is `pending` (`_validFromDateTime: null`) and `private`. Only Alice can see it.

---

### 7.2 Admin Reviews and Approves the Book

**Admin can list all pending books:**
```bash
ADMIN_TOKEN="eyJhbGci..."   # token with roles=["books.admin"]

curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  "http://localhost:8081/api/v1/books?filter[where][_validFromDateTime][eq]=null&filter[where][_visibility]=private"
```

**Admin approves the book (sets `_validFromDateTime` and makes it public):**
```bash
curl -X PATCH "http://localhost:8081/api/v1/books/book-anna-uuid-1111" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "_validFromDateTime": "2024-11-15T10:00:00.000Z",
    "_visibility": "public"
  }'
```

**Response (HTTP 200):**
```json
{
  "_id": "book-anna-uuid-1111",
  "_name": "Anna Karenina",
  "_kind": "book",
  "_slug": "anna-karenina",
  "_visibility": "public",
  "_validFromDateTime": "2024-11-15T10:00:00.000Z",
  "_validUntilDateTime": null,
  "_ownerUsers": ["alice-uuid"],
  "_createdBy": "alice-uuid",
  "_createdDateTime": "2024-11-15T09:00:00.000Z",
  "_lastUpdatedDateTime": "2024-11-15T10:00:00.000Z",
  "_lastUpdatedBy": "admin-uuid",
  "_version": 2,
  "author": "Leo Tolstoy",
  "isbn": "978-0-14-303500-9",
  "genre": "Fiction",
  "pages": 864
}
```

**State:** Book is now `active` and `public`. Any authenticated user can find it via `?q=actives`.

---

### 7.3 Alice Creates a Shelf and Adds the Book to It

```bash
# Create shelf
curl -X POST http://localhost:8081/api/v1/shelves \
  -H "Authorization: Bearer $ALICE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"_name": "Russian Classics"}'
```

**Response (HTTP 201):**
```json
{
  "_id": "shelf-russian-uuid-2222",
  "_name": "Russian Classics",
  "_kind": "shelf",
  "_slug": "russian-classics",
  "_visibility": "protected",
  "_validFromDateTime": "2024-11-15T10:30:00.000Z",
  "_ownerUsers": ["alice-uuid"],
  "_createdBy": "alice-uuid",
  "_createdDateTime": "2024-11-15T10:30:00.000Z",
  "_version": 1
}
```

```bash
# Add Anna Karenina to the shelf
curl -X POST "http://localhost:8081/api/v1/shelves/shelf-russian-uuid-2222/entities/books" \
  -H "Authorization: Bearer $ALICE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "_entityId": "book-anna-uuid-1111",
    "addedNote": "Masterpiece of 19th century literature"
  }'
```

**Response (HTTP 201):**
```json
{
  "_id": "rel-uuid-3333-4444",
  "_kind": "book-in-shelf",
  "_listId": "shelf-russian-uuid-2222",
  "_entityId": "book-anna-uuid-1111",
  "_validFromDateTime": "2024-11-15T10:31:00.000Z",
  "_ownerUsers": ["alice-uuid"],
  "_createdBy": "alice-uuid",
  "_createdDateTime": "2024-11-15T10:31:00.000Z",
  "_version": 1,
  "addedNote": "Masterpiece of 19th century literature"
}
```

```bash
# Verify: list books in the shelf
curl -H "Authorization: Bearer $ALICE_TOKEN" \
  "http://localhost:8081/api/v1/shelves/shelf-russian-uuid-2222/entities/books"
```

**Response (HTTP 200):**
```json
[
  {
    "_id": "book-anna-uuid-1111",
    "_name": "Anna Karenina",
    "_slug": "anna-karenina",
    "_visibility": "public",
    "_validFromDateTime": "2024-11-15T10:00:00.000Z",
    "author": "Leo Tolstoy",
    "genre": "Fiction"
  }
]
```

---

### 7.4 Another User (Bob) Writes a Review

```bash
BOB_TOKEN="eyJhbGci..."   # token with roles=["books.member"], sub="bob-uuid"

curl -X POST "http://localhost:8081/api/v1/books/book-anna-uuid-1111/reactions/reviews" \
  -H "Authorization: Bearer $BOB_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "rating": 5,
    "body": "Tolstoy''s depiction of Anna is heartbreaking and utterly convincing. Required reading.",
    "spoiler": false
  }'
```

**Response (HTTP 201):**
```json
{
  "_id": "rev-uuid-5555-6666",
  "_kind": "review",
  "_entityId": "book-anna-uuid-1111",
  "_visibility": "public",
  "_validFromDateTime": "2024-11-15T14:00:00.000Z",
  "_ownerUsers": ["bob-uuid"],
  "_createdBy": "bob-uuid",
  "_createdDateTime": "2024-11-15T14:00:00.000Z",
  "_version": 1,
  "rating": 5,
  "body": "Tolstoy's depiction of Anna is heartbreaking and utterly convincing. Required reading.",
  "spoiler": false
}
```

> `AUTOAPPROVE_ENTITY_FOR_REVIEW=true` and `VISIBILITY_ENTITY_FOR_REVIEW=public` mean the review is immediately active and public — no admin action required.

```bash
# Alice (or anyone) can now read Bob's review
curl -H "Authorization: Bearer $ALICE_TOKEN" \
  "http://localhost:8081/api/v1/books/book-anna-uuid-1111/reactions/reviews?q=actives"
```

**Response (HTTP 200):**
```json
[
  {
    "_id": "rev-uuid-5555-6666",
    "_kind": "review",
    "_entityId": "book-anna-uuid-1111",
    "_visibility": "public",
    "_validFromDateTime": "2024-11-15T14:00:00.000Z",
    "_createdBy": "bob-uuid",
    "rating": 5,
    "body": "Tolstoy's depiction of Anna is heartbreaking and utterly convincing. Required reading.",
    "spoiler": false
  }
]
```

---

### 7.5 Admin Views Everything via the GUI

The admin opens the GUI at `http://localhost:5173`, connects to `http://localhost:8081`, and enters their `books.admin` Bearer token.

Because the admin token includes the `books.admin` role, the gateway generates a personalized OAS spec that:
- Includes all managed fields (`_validFromDateTime`, `_ownerUsers`, `_createdBy`, etc.) in GET response schemas and POST/PATCH forms
- Includes Create, Edit, and Delete buttons for all resources
- Shows `_validFromDateTime` as a form field (allowing direct approval from the create/edit form)

**What the admin sees:**
- **Books grid**: all books regardless of visibility or approval state (no sets filtering injected for admins)
- Clicking "Anna Karenina" shows the detail view with a **Chapters** sub-resource tab
- The **Shelves** grid shows Alice's "Russian Classics" shelf; clicking it shows the **Books** traversal tab with Anna Karenina listed
- The **Reviews** grid shows Bob's review immediately (auto-approved, public)

The admin can approve pending books directly from the Books grid edit form by setting `_validFromDateTime` to now and `_visibility` to `public` — without using curl.

---

## Related Documents
- `22_CONCEPT_domain-projection.md` — Domain projection mechanics, kind alias configuration, traversal routes
- `41_EXAMPLE_adding-a-new-kind.md` — Adding a new kind to this deployment
- `42_EXAMPLE_custom-business-logic.md` — Extending this app with the orchestrator (author `tapp://` URI enrichment)
- `21_CONCEPT_security-and-authorization.md` — Role-based access in practice, Keycloak token mapper setup
- `12_COMPONENT_gateway-policies.md` — OPA role model, field-level roles, and forbidden field mechanics
- `14_COMPONENT_tarcinapp-base-gui.md` — How the GUI derives navigation, forms, and traversal links from the OAS spec
