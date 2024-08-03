DATABASE_NAME = delterra_hackathon

createdb:
	psql -d postgres -c "CREATE DATABASE $(DATABASE_NAME);" || true

createrole:
	psql -d postgres -c "CREATE ROLE postgres LOGIN SUPERUSER;" || true

.PHONY: createdb createrole