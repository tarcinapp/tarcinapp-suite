# 40_EXAMPLE_books-app.md

## Overview

This walkthrough builds a complete books application on Tarcinapp from zero. At the end, you'll have:

- `GET /api/v1/books` — list books
- `POST /api/v1/books` — create a book
- `GET /api/v1/books/{id}/chapters` — get sub-chapters
- `GET /api/v1/shelves` — list bookshelves
- `POST /api/v1/shelves/{id}/entities/books` — add a book to a shelf
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

---

## Step 1: Configure entity-persistence-service

Set environment variables (or `.env` file):

```bash
# Allowed kinds
ENTITY_KINDS=book,chapter,author
LIST_KINDS=shelf
LIST_ENTITY_REL_KINDS=book-in-shelf
ENTITY_REACTION_KINDS=review,rating,like

# Auto approve
AUTOAPPROVE_ENTITY=false         # books need admin approval
AUTOAPPROVE_LIST=true            # shelves are immediately active
AUTOAPPROVE_LIST_ENTITY_RELATIONS=true
AUTOAPPROVE_ENTITY_REACTION=true # reviews appear immediately

# Visibility defaults
VISIBILITY_ENTITY=private        # new books are private until published
VISIBILITY_LIST=protected        # shelves visible to friends
VISIBILITY_ENTITY_REACTION=public # reviews are public

# Uniqueness: no duplicate book titles per author
ENTITY_UNIQUENESS='where[_kind]=${_kind}&where[_slug]=${_slug}&where[_createdBy]=${_createdBy}'

# Response limits
RESPONSE_LIMIT_ENTITY=50
RESPONSE_LIMIT_LIST=100
RESPONSE_LIMIT_ENTITY_REACTION=100

# Record limits: max 100 books per user, max 10 reviews per entity per user
ENTITY_RECORD_LIMITS='[{"scope":"where[_kind]=book","limit":100},{"scope":"where[_kind]=review","limit":10}]'
```

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

# Kind aliases
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

# JSON Schema for books (validates POST /books and PUT /books/{id})
APP_KINDALIASPATHS_0_SCHEMA={"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"author":{"type":"string","minLength":1},"isbn":{"type":"string","pattern":"^[0-9-]{10,17}$"},"genre":{"type":"string"},"pages":{"type":"integer","minimum":1}},"required":["author"]}

# JSON Schema for reviews
APP_KINDALIASPATHS_3_SCHEMA={"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"rating":{"type":"integer","minimum":1,"maximum":5},"body":{"type":"string","minLength":10,"maxLength":5000}},"required":["rating","body"]}

# Saved queries
APP_QUERIES_MY=my books:  "'sets[owners][userIds]='+#userId"
APP_QUERIES_ACTIVES="'sets[actives]'"
APP_QUERIES_BY_AUTHOR="'filter[where][author]='+#query['author-name']"

# Field sets
APP_FIELDSETS_SUMMARY_SHOW=_id,_name,_slug,author,genre,_visibility,_validFromDateTime
APP_FIELDSETS_DETAIL_SHOW=_id,_name,_slug,author,isbn,genre,pages,_visibility,_createdDateTime,_lastUpdatedDateTime

# Default fieldset for books (summary view by default)
APP_DEFAULTFIELDSET_ENTITIES=summary

# Disable generic routes — expose only domain-specific API
APP_ROUTES_TAGS_DISABLED=generic

# Rate limiting for book creation
APP_KINDALIASPATHS_0_RATELIMITER_REPLENISHRATE=5
APP_KINDALIASPATHS_0_RATELIMITER_BURSTCAPACITY=10
```

---

## Step 3: Set Up Keycloak Roles

In Keycloak, create the following roles and assign them to users:

| Role | Who gets it |
|:---|:---|
| `books.admin` | Administrators — full access |
| `books.editor` | Editors — can publish (set `_validFromDateTime`), manage all content |
| `books.member` | Registered users — can create, own their content |
| `books.visitor` | Anonymous or unverified users — read-only |

Configure the Keycloak token mapper to include `roles` as a flat string array at the token root, and `groups` for group-based ownership.

---

## Step 4: Test the API

### Create a book (as member)
```bash
# JWT for books.member user
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
3. Validates payload against books JSON Schema → `author` present, `pages` is integer → passes
4. Injects `_kind=book` into payload
5. Injects `_createdBy=user-uuid`, `_ownerUsers=["user-uuid"]`, `_createdDateTime=now`
6. `_validFromDateTime` is NOT set (member is forbidden from setting it, auto-approve is false) → book is PENDING
7. `_visibility=private` (default)
8. Proxies to EPS `POST /entities`

**Response:**
```json
{
  "_id": "a1b2c3d4-...",
  "_name": "War and Peace",
  "_kind": "book",
  "_slug": "war-and-peace",
  "_visibility": "private",
  "_validFromDateTime": null,
  "_ownerUsers": ["user-uuid"],
  "_createdBy": "user-uuid",
  "_createdDateTime": "2024-11-01T10:00:00Z",
  "author": "Leo Tolstoy",
  "isbn": "978-0-14-028723-0",
  "genre": "Historical Fiction",
  "pages": 1225
}
```

### Approve the book (as admin)
```bash
ADMIN_TOKEN="eyJhbGci..."

curl -X PATCH http://localhost:8081/api/v1/books/a1b2c3d4-... \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "_validFromDateTime": "2024-11-01T10:00:00Z",
    "_visibility": "public"
  }'
```

After this, the book is `active` and `public` — visible to all users.

### List active public books
```bash
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8081/api/v1/books?q=actives&fieldset=summary"
```

### List my books (including pending/private)
```bash
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8081/api/v1/books?q=my"
```

### Create a chapter (child entity)
```bash
curl -X POST "http://localhost:8081/api/v1/books/a1b2c3d4-.../chapters" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"_name": "Part One: Peace", "orderIndex": 1}'
```

### Create a shelf and add a book to it
```bash
# Create shelf
curl -X POST http://localhost:8081/api/v1/shelves \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"_name": "My Favorites"}'

# Add book to shelf (creates a ListEntityRelation record)
curl -X POST "http://localhost:8081/api/v1/shelves/shelf-uuid-.../entities/books" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"addedNote": "A masterpiece"}'
```

### Write a review
```bash
curl -X POST "http://localhost:8081/api/v1/books/a1b2c3d4-.../reactions/reviews" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"rating": 5, "body": "One of the greatest novels ever written."}'
```

### Get reviews for a book
```bash
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8081/api/v1/books/a1b2c3d4-.../reactions/reviews?q=actives"
```

---

## Step 5: What the GUI Renders

Start the `tarcinapp-base-gui` and connect to `http://localhost:8081`. With `APP_ROUTES_TAGS_DISABLED=generic`:

**Sidebar entries:**
- Books (entity)
- Chapters (entity, nested under Books)
- Shelves (list)
- Authors (entity)
- Reviews (entity-reaction)
- Ratings (entity-reaction)

Each entry shows a paginated data grid. Columns are derived from the gateway's personalized OAS spec. An admin will see all fields including `_validFromDateTime`; a visitor will only see public-facing fields.

**Create form for Books:**
The form shows: `_name` (required), `author` (required by schema), `isbn`, `genre`, `pages`. It does not show `_ownerUsers`, `_createdBy`, or `_validFromDateTime` — because the member's OPA policy marks those as forbidden for create operations.

---

## Step 6: Search by Author

With the saved query `APP_QUERIES_BY_AUTHOR` configured:

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8081/api/v1/books?q=by-author&author-name=Tolstoy"
```

The gateway expands this to `filter[where][author]=Tolstoy` before calling EPS.

---

## Related Documents
- `22_CONCEPT_domain-projection.md` — Domain projection mechanics
- `41_EXAMPLE_adding-a-new-kind.md` — Adding a new kind to this deployment
- `21_CONCEPT_security-and-authorization.md` — Role-based access in practice
- `12_COMPONENT_gateway-policies.md` — OPA role model and field defaults
