# Product Requirements Document: Trips API for Openclaw

## 1. Overview
The goal of this project is to build a comprehensive "TripIt-like" service that provides structured APIs to track and manage all aspects of travel. It will support not only core itineraries, but also advanced features like participant collaboration, expense tracking, and document storage. This service will act as a backend deployed on **Cloudflare Workers**, exposing endpoints that allow an external agent (Openclaw) to manage these trips.

## 2. Goals
- Provide comprehensive structured data models mirroring TripIt and Wanderlog (Travelers, Itineraries, Expenses, Documents).
- Expose RESTful APIs for Openclaw to Create, Read, Update, and Delete (CRUD) these resources.
- Enable automatic generation of OpenAPI schemas so Openclaw can easily parse and interact with the endpoints.
- Deploy the service at the edge using Cloudflare Workers and Cloudflare D1.

## 3. Data Models

### 3.1 Trip
A logical grouping of travel events.
- `id`: Unique identifier (UUID string)
- `name`: Name of the trip
- `destination`: Primary destination (Optional)
- `start_date` / `end_date`: Optional dates
- `description`: Optional text description

### 3.2 Trip Participant (Traveler)
Represents a person on the trip, allowing collaboration.
- `id`: Unique identifier
- `trip_id`: Reference to parent trip
- `user_id` / `email`: Identifier for the person
- `name`: Display name
- `role`: e.g., "Owner", "Editor", "Viewer"

### 3.3 Expense Trading & Splits
Tracks budgets and who paid what.
- `id`: Unique identifier
- `trip_id`: Reference to parent trip
- `description`: What the expense was for
- `amount`: Numeric float
- `currency`: 3-letter ISO code
- `category`: e.g., "Food", "Transport", "Accommodation"
- `payer_id`: Reference to the `Participant` who paid
- `split_type`: e.g., "EQUAL", "EXACT", "PERCENTAGE"

### 3.4 Document / Attachment
Stores references to critical files (boarding passes, tickets).
- `id`: Unique identifier
- `trip_id`: Reference to parent trip
- `reservation_id`: Optional reference to a specific itinerary item
- `file_url`: URL or storage path to the file
- `document_type`: e.g., "PDF_TICKET", "IMAGE_RECEIPT"
- `name`: Name of the document

### 3.5 Common Reservation Fields
All itinerary items below share these tracking fields:
- `id`: Unique identifier
- `trip_id`: Reference to trip
- `type`: Category (Flight, Lodging, Rail, Car, Restaurant, Activity, Transport)
- `status`: Confirmed, Pending, Cancelled
- `confirmation_number`: Booking reference
- `booking_agency`: E.g., Expedia
- `total_cost`: Numeric float
- `currency`: 3-letter ISO code
- `notes`: Markdown or text notes
- `cancellation_policy`: Free text / Markdown describing the full cancellation policy
- `provider_url`: URL to the booking provider for price monitoring

### 3.6 Flight Reservation (Air)
- `airline`, `flight_number` (Primary/marketing carrier)
- `departure_airport`, `departure_time` (Initial origin)
- `arrival_airport`, `arrival_time` (Final destination)
- `fare_class`: Specific fare class code or ticket type (e.g., "Basic Economy", "Y", "J")
- `baggage_allowance`: Description of included baggage (e.g., "1 carry-on")
- `travelers`: Array of passengers included in this reservation:
  - `participant_id` (Reference to trip traveler), `name`, `ticket_number`
- `legs`: Optional array of individual flight segments (for layovers and connections), each containing:
  - `airline`, `flight_number`
  - `departure_airport`, `departure_time`
  - `arrival_airport`, `arrival_time`
  - `cabin_class`
  - `seat_assignments`: Array or map detailing which traveler is assigned which `seat_number`

### 3.7 Lodging (Hotel)
- `property_name`, `address`, `check_in_time`, `check_out_time`, `room_type`
- `board_basis`: Meal plan (e.g., "Breakfast Included", "Room Only")
- `view_type`: Room view (e.g., "Ocean View")
- `travelers`: Array of participants staying in this lodging (reference `participant_id` and `name`)

### 3.8 Rail Reservation
- `train_operator`, `train_number`, `departure_station`, `departure_time`, `arrival_station`, `arrival_time`
- `travelers`: Array of passengers included in this reservation (`participant_id`, `name`, `ticket_number`)
- `seat_assignments`: Array or map detailing which traveler is assigned which `carriage_number` and `seat_number`

### 3.9 Car Rental
- `rental_company`, `pick_up_location`, `pick_up_time`, `drop_off_location`, `drop_off_time`, `vehicle_type`
- `transmission_type`: "Automatic" vs "Manual"
- `mileage_policy`: E.g., "Unlimited", "200 miles/day"
- `travelers`: Array of participants attached to the rental:
  - `participant_id`, `name`, `driver_role` (e.g., "Primary Driver", "Additional Driver", "Passenger")

### 3.10 Restaurant Reservation
- `restaurant_name`, `address`, `reservation_time`, `party_size`
- `travelers`: Array of specific participants attending (`participant_id`, `name`)

### 3.11 Transport (Bus/Ferry)
- `transport_type`, `operator`, `departure_location`, `departure_time`, `arrival_location`, `arrival_time`
- `travelers`: Array of passengers included in this reservation (`participant_id`, `name`, `ticket_number`)
- `seat_assignments`: (Optional) Map detailing which traveler is assigned which `seat_number`

### 3.12 Activity / Generic Plan
- `name`, `location`, `start_time`, `end_time`
- `travelers`: Array of participants attending this activity (`participant_id`, `name`)

## 4. API Endpoints

**Authentication:**
The API is protected by **Cloudflare Access** and enforces **Cloudflare Service Tokens**. 
- Requests require static headers: `CF-Access-Client-Id` and `CF-Access-Client-Secret`.
- The Cloudflare edge network intercepts, validates, and injects a `CF-Access-Jwt-Assertion` header.
- The Trips API verifies this signed JWT mathematically against the Cloudflare public JWKS endpoint.

### 4.1 Trips & Nested Collections
- `GET`, `POST` `/trips`
- Standard `PUT`, `DELETE` `/trips/{trip_id}`
- Sub-routes for nested models: 
  - `/trips/{trip_id}/participants`
  - `/trips/{trip_id}/expenses`
  - `/trips/{trip_id}/documents`
  - `/trips/{trip_id}/itineraries` (Polymorphic endpoint handling all 7 reservation types. Supports `GET`, `POST`, and `PUT /trips/{trip_id}/itineraries/{itin_id}`)

## 5. Technology Stack
- **Platform**: Cloudflare Workers
- **Language**: TypeScript
- **Framework**: Hono (`@hono/zod-openapi`)
- **Database**: Cloudflare D1
- **Validation**: Zod
