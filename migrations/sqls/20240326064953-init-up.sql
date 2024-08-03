CREATE TABLE IF NOT EXISTS waste_status
(
    id serial PRIMARY KEY,
    name VARCHAR (50) NOT NULL
);

CREATE TABLE IF NOT EXISTS humidity_types
(
    id serial PRIMARY KEY,
    level VARCHAR (50) NOT NULL,
    name VARCHAR (50) NOT NULL
);

CREATE TABLE IF NOT EXISTS storage_areas
(
    id serial PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    width NUMERIC NOT NULL,
    length NUMERIC NOT NULL,
    height NUMERIC NOT NULL
);

CREATE TABLE IF NOT EXISTS inbound_deliveries
(
    id serial PRIMARY KEY,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    rejected_weight NUMERIC,
    organic_weight NUMERIC,
    inorganic_weight NUMERIC,
    hard_organic_weight NUMERIC,
    license_plate VARCHAR (50),
    note VARCHAR (255)
);

CREATE TABLE IF NOT EXISTS waste
(
    id serial PRIMARY KEY,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    modified_at TIMESTAMP NOT NULL DEFAULT NOW(),
    inbound_delivery_id INTEGER NOT NULL REFERENCES inbound_deliveries(id) ON DELETE CASCADE,
    simple_id INTEGER UNIQUE
);

CREATE TABLE IF NOT EXISTS waste_logs
(
    id serial PRIMARY KEY,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    next_checked_date TIMESTAMP,
    waste_id INTEGER NOT NULL REFERENCES waste(id) ON DELETE CASCADE,
    humidity_types INTEGER REFERENCES humidity_types(id) ON DELETE CASCADE,
    curr_waste_status INTEGER REFERENCES waste_status(id) ON DELETE CASCADE,
    next_waste_status INTEGER REFERENCES waste_status(id) ON DELETE CASCADE,
    curr_storage_area_id INTEGER REFERENCES storage_areas(id) ON DELETE CASCADE,
    next_storage_area_id INTEGER REFERENCES storage_areas(id) ON DELETE CASCADE,
    weight NUMERIC,
    volume NUMERIC,
    temperature NUMERIC,
    note VARCHAR (255),
    is_mixed BOOLEAN DEFAULT FALSE,
    is_rejected BOOLEAN DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS sales_invoices
(
    id serial PRIMARY KEY,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    note VARCHAR (255)
);

CREATE TABLE IF NOT EXISTS composts
(
    id serial PRIMARY KEY,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    modified_at TIMESTAMP NOT NULL DEFAULT NOW(),
    sales_invoice_id INTEGER REFERENCES sales_invoices(id) ON DELETE CASCADE,
    storage_area_id INTEGER REFERENCES storage_areas(id) ON DELETE CASCADE,
    simple_id INTEGER UNIQUE,
    weight NUMERIC,
    volume NUMERIC,
    price NUMERIC,
    note VARCHAR (255)
);