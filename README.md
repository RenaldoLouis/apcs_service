# Deltera Services

## Introduction

This project is a Node.js application that provides various services for the Deltera platform.

## Requirements

Before running the application, ensure you have the following prerequisites installed on your system:

- [Node.js](https://nodejs.org/) v14.17+ installed
- [PostgreSQL](https://www.postgresql.org/) 14.8+ installed

## Installation

Follow these steps to install and set up the project:

1. Install db-migrate globally:

   ```bash
    npm install -g db-migrate
   ```

2. Install db-migrate-pg globally:

   ```bash
    npm install -g db-migrate-pg
   ```

3. Install project dependencies:

   ```bash
    npm install
   ```

4. Create Database:

   ```bash
   chmod +x Makefile
   make createdb
   ```

5. Create Table:

   ```bash
   db-migrate up
   ```

## Usage

```bash
  node index.js
```
