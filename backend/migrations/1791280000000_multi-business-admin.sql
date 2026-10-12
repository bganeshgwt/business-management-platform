-- Up Migration
-- Business-neutral aggregate roots. Existing restaurant IDs and transaction
-- history remain intact; the bridge is one-to-one, never a reinterpretation.
CREATE TABLE business_types (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL
);
INSERT INTO business_types(code,name) VALUES
 ('restaurant','Restaurant & food outlets'), ('grocery','Grocery & kirana'),
 ('supermarket','Supermarkets & department stores'), ('wholesale','Wholesale & FMCG distribution'),
 ('fashion','Garments & textiles'), ('electronics','Electronics & mobiles'),
 ('pharmacy','Pharmacy'), ('books','Books & stationery'), ('salon','Salon & spa'),
 ('healthcare','Clinics & diagnostic labs'), ('meat','Meat & seafood'),
 ('weight_retail','Other weight-based shops');

CREATE TABLE businesses (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 name VARCHAR(150) NOT NULL,
 code VARCHAR(40) NOT NULL UNIQUE,
 business_type TEXT NOT NULL REFERENCES business_types(code),
 legacy_restaurant_id BIGINT UNIQUE REFERENCES restaurants(id),
 is_demo BOOLEAN NOT NULL DEFAULT FALSE,
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','inactive')),
 currency CHAR(3) NOT NULL DEFAULT 'INR',
 timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
 created_by BIGINT REFERENCES users(id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CHECK(legacy_restaurant_id IS NULL OR business_type='restaurant')
);
CREATE TABLE business_memberships (
 business_id BIGINT NOT NULL REFERENCES businesses(id),
 user_id BIGINT NOT NULL REFERENCES users(id),
 role TEXT NOT NULL CHECK(role IN ('owner','manager','viewer')),
 active BOOLEAN NOT NULL DEFAULT TRUE,
 PRIMARY KEY(business_id,user_id)
);
CREATE INDEX business_memberships_user ON business_memberships(user_id,business_id);
CREATE TABLE business_capabilities (
 business_id BIGINT NOT NULL REFERENCES businesses(id),
 capability TEXT NOT NULL CHECK(capability IN
 ('catalog','inventory','purchasing','sales','contacts','appointments','variants','serials','batches','weight','wholesale','books','restaurant')),
 PRIMARY KEY(business_id,capability)
);
CREATE TABLE business_locations (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 business_id BIGINT NOT NULL REFERENCES businesses(id),
 name VARCHAR(150) NOT NULL,
 code VARCHAR(30) NOT NULL,
 active BOOLEAN NOT NULL DEFAULT TRUE,
 UNIQUE(business_id,id), UNIQUE(business_id,code)
);
CREATE TABLE business_contacts (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 business_id BIGINT NOT NULL REFERENCES businesses(id),
 kind TEXT NOT NULL CHECK(kind IN ('customer','supplier')),
 name VARCHAR(150) NOT NULL,
 phone VARCHAR(30), email VARCHAR(150), address VARCHAR(500),
 active BOOLEAN NOT NULL DEFAULT TRUE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(business_id,id)
);
CREATE INDEX business_contacts_search ON business_contacts(business_id,kind,name);
CREATE TABLE catalog_products (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 business_id BIGINT NOT NULL REFERENCES businesses(id),
 name VARCHAR(150) NOT NULL,
 category VARCHAR(100), brand VARCHAR(100),
 kind TEXT NOT NULL CHECK(kind IN ('goods','service')),
 active BOOLEAN NOT NULL DEFAULT TRUE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(business_id,id)
);
CREATE TABLE catalog_skus (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 business_id BIGINT NOT NULL REFERENCES businesses(id),
 product_id BIGINT NOT NULL,
 code VARCHAR(60) NOT NULL,
 barcode VARCHAR(80), label VARCHAR(150) NOT NULL,
 unit TEXT NOT NULL CHECK(unit IN ('each','kg','g','litre','ml','metre','hour','service')),
 price NUMERIC(14,2) NOT NULL CHECK(price>=0),
 tax_rate NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK(tax_rate BETWEEN 0 AND 100),
 tracking TEXT NOT NULL DEFAULT 'none' CHECK(tracking IN ('none','quantity','batch','serial')),
 reorder_level NUMERIC(16,3) NOT NULL DEFAULT 0 CHECK(reorder_level>=0),
 attributes JSONB NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(attributes)='object'),
 active BOOLEAN NOT NULL DEFAULT TRUE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 FOREIGN KEY(business_id,product_id) REFERENCES catalog_products(business_id,id),
 UNIQUE(business_id,id), UNIQUE(business_id,code), UNIQUE(business_id,barcode)
);
CREATE TABLE business_stock_lots (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 business_id BIGINT NOT NULL REFERENCES businesses(id),
 location_id BIGINT NOT NULL,
 sku_id BIGINT NOT NULL,
 lot_code VARCHAR(100) NOT NULL DEFAULT '',
 expires_on DATE,
 quantity NUMERIC(16,3) NOT NULL DEFAULT 0 CHECK(quantity>=0),
 unit_cost NUMERIC(14,4) NOT NULL DEFAULT 0 CHECK(unit_cost>=0),
 FOREIGN KEY(business_id,location_id) REFERENCES business_locations(business_id,id),
 FOREIGN KEY(business_id,sku_id) REFERENCES catalog_skus(business_id,id),
 UNIQUE(business_id,id), UNIQUE(business_id,location_id,sku_id,lot_code)
);
CREATE TABLE business_documents (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 business_id BIGINT NOT NULL REFERENCES businesses(id),
 location_id BIGINT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('sale','purchase')),
 document_no VARCHAR(50) NOT NULL,
 contact_id BIGINT,
 contact_name VARCHAR(150),
 subtotal NUMERIC(16,2) NOT NULL CHECK(subtotal>=0),
 tax NUMERIC(16,2) NOT NULL CHECK(tax>=0),
 total NUMERIC(16,2) NOT NULL CHECK(total>=0 AND total=subtotal+tax),
 request_key UUID NOT NULL,
 request_hash CHAR(64) NOT NULL,
 notes VARCHAR(500),
 created_by BIGINT NOT NULL REFERENCES users(id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 FOREIGN KEY(business_id,location_id) REFERENCES business_locations(business_id,id),
 FOREIGN KEY(business_id,contact_id) REFERENCES business_contacts(business_id,id),
 UNIQUE(business_id,id), UNIQUE(business_id,document_no), UNIQUE(business_id,request_key)
);
CREATE TABLE business_document_lines (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 business_id BIGINT NOT NULL,
 document_id BIGINT NOT NULL,
 sku_id BIGINT NOT NULL,
 label VARCHAR(150) NOT NULL,
 unit TEXT NOT NULL,
 quantity NUMERIC(16,3) NOT NULL CHECK(quantity>0),
 unit_price NUMERIC(14,2) NOT NULL CHECK(unit_price>=0),
 tax_rate NUMERIC(5,2) NOT NULL CHECK(tax_rate BETWEEN 0 AND 100),
 net NUMERIC(16,2) NOT NULL CHECK(net>=0),
 tax NUMERIC(16,2) NOT NULL CHECK(tax>=0),
 lot_code VARCHAR(100) NOT NULL DEFAULT '',
 FOREIGN KEY(business_id,document_id) REFERENCES business_documents(business_id,id),
 FOREIGN KEY(business_id,sku_id) REFERENCES catalog_skus(business_id,id)
);
CREATE TABLE business_stock_movements (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 business_id BIGINT NOT NULL,
 lot_id BIGINT NOT NULL,
 document_id BIGINT NOT NULL,
 quantity NUMERIC(16,3) NOT NULL CHECK(quantity<>0),
 balance_after NUMERIC(16,3) NOT NULL CHECK(balance_after>=0),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 FOREIGN KEY(business_id,lot_id) REFERENCES business_stock_lots(business_id,id),
 FOREIGN KEY(business_id,document_id) REFERENCES business_documents(business_id,id)
);
CREATE TABLE business_payments (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 business_id BIGINT NOT NULL,
 document_id BIGINT NOT NULL,
 amount NUMERIC(16,2) NOT NULL CHECK(amount>0),
 method TEXT NOT NULL CHECK(method IN ('cash','card','upi','bank')),
 reference VARCHAR(100), request_key UUID NOT NULL,
 created_by BIGINT NOT NULL REFERENCES users(id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 FOREIGN KEY(business_id,document_id) REFERENCES business_documents(business_id,id),
 UNIQUE(business_id,request_key)
);
CREATE TABLE business_resources (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 business_id BIGINT NOT NULL REFERENCES businesses(id),
 location_id BIGINT NOT NULL,
 name VARCHAR(150) NOT NULL,
 role_label VARCHAR(100),
 active BOOLEAN NOT NULL DEFAULT TRUE,
 FOREIGN KEY(business_id,location_id) REFERENCES business_locations(business_id,id),
 UNIQUE(business_id,id)
);
CREATE TABLE business_appointments (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 business_id BIGINT NOT NULL REFERENCES businesses(id),
 resource_id BIGINT NOT NULL,
 contact_id BIGINT NOT NULL,
 sku_id BIGINT NOT NULL,
 starts_at TIMESTAMPTZ NOT NULL,
 ends_at TIMESTAMPTZ NOT NULL CHECK(ends_at>starts_at),
 status TEXT NOT NULL DEFAULT 'booked' CHECK(status IN ('booked','completed','cancelled','no_show')),
 created_by BIGINT NOT NULL REFERENCES users(id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 FOREIGN KEY(business_id,resource_id) REFERENCES business_resources(business_id,id),
 FOREIGN KEY(business_id,contact_id) REFERENCES business_contacts(business_id,id),
 FOREIGN KEY(business_id,sku_id) REFERENCES catalog_skus(business_id,id),
 UNIQUE(business_id,id)
);
CREATE INDEX business_appointments_schedule ON business_appointments(business_id,resource_id,starts_at,ends_at) WHERE status='booked';
CREATE TABLE business_audit (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 business_id BIGINT NOT NULL REFERENCES businesses(id),
 actor_id BIGINT NOT NULL REFERENCES users(id),
 action TEXT NOT NULL,
 entity_id BIGINT,
 details JSONB NOT NULL DEFAULT '{}',
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX business_audit_time ON business_audit(business_id,created_at DESC);

INSERT INTO businesses(name,code,business_type,legacy_restaurant_id,status)
 SELECT name,code,'restaurant',id,CASE WHEN status='active' THEN 'active' ELSE 'inactive' END FROM restaurants;
INSERT INTO business_memberships(business_id,user_id,role)
 SELECT DISTINCT b.id,u.id,'owner' FROM businesses b JOIN users u ON u.restaurant_id=b.legacy_restaurant_id
 JOIN user_roles ur ON ur.user_id=u.id JOIN roles r ON r.id=ur.role_id WHERE r.code='RESTAURANT_ADMIN';
INSERT INTO business_capabilities(business_id,capability) SELECT id,'restaurant' FROM businesses;

-- Down Migration
DROP TABLE business_audit, business_appointments, business_resources, business_payments,
 business_stock_movements, business_document_lines, business_documents, business_stock_lots,
 catalog_skus, catalog_products, business_contacts, business_locations,
 business_capabilities, business_memberships, businesses, business_types;
