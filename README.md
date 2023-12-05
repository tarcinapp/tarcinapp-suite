Tarcinapp Suite is an interconnected microservices family that helps you to create JSON APIs easily. For example: 
* `GET` - `/api/v1/books`
* `GET` - `/api/v1/books/count`
* `POST` - `/api/v1/books`
* `PATCH` - `/api/v1/books`
* `GET` - `/api/v1/books/{book-id}`
* `PUT` - `/api/v1/books/{book-id}`
* `PATCH` - `/api/v1/books/{book-id}`
* `DELETE` - `/api/v1/books/{book-id}`
`books` is used as an example. Any endpoint can be defined with it's own custom JSON schema.
  
Furthermore you can:
* Require JWT authentication
* Configure role based access (RBAC)
* Configure field-level operations based on fine-grained user roles
* Perform JSON schema based validation during the creation and update
* Enable caching
* Apply rate limiting
* Use distributed locking during the update operations
* Enable/disable REST operations
* Predefine complex queries to allow simpler query strings
* Predefine sets of data fields for easier querying
* Configure entity level visibility settings and define default visibility (private, protected, public)
* Prevent user's access each other's data when not explicitly allowed to do
* Require approval from users with higher roles for created entities
* Query pagination
* Mark entities as deleted instead of really deleting them
* Tag entities
* Track creation and last update dates
* Track user IDs for both creators and last updaters
* Monitor request and response payloads
* Have dashboard for the usage data in Grafana
# Use Cases
# Components
1. entity-persistence-service
2. entity-persistence-integration
3. entity-persistence-gateway
4. entity-persistence-dos-protection
# Usage
## Getting Start
Quick Start or configure yourself:
### Quick Start
### Configure Your Application
* Configure Application
* Choose a Deployment Layout
* Run the application.

## Deployment 
### Kubernetes
### Docker
