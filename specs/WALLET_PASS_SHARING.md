# Functional Design: iOS Wallet Card Sharing

## 1. Overview

This feature enables users to generate Apple Wallet passes (`.pkpass` files) from their trip itineraries and share them with other people. Each itinerary item (flight, hotel, train, car rental, restaurant, activity, or transport) can be converted into a visually rich wallet card that recipients can add to Apple Wallet on their iPhone or Apple Watch -- even if they don't have an account on the Trips app.

### Goals

- Let any trip participant generate a wallet pass for any itinerary item they can view.
- Produce passes that are useful standalone: all key booking details visible at a glance, relevant at the right time and place via lock-screen surfacing.
- Enable frictionless sharing of passes to other travelers (co-travelers, family, assistants) via a public link -- no login required to download.
- Support pass updates: when itinerary details change, previously-issued passes can be refreshed.

### Non-Goals (v1)

- Google Wallet support (future follow-up).
- Barcode/QR scanning at airport gates (we are not the airline; passes are informational).
- Bulk pass generation for an entire trip at once.
- Push notification delivery of pass updates (polling-based update registration only in v1).

---

## 2. User Stories

| # | As a... | I want to... | So that... |
|---|---------|-------------|-----------|
| 1 | Trip participant | tap "Add to Wallet" on a flight itinerary | I can see my flight details on my lock screen at the airport |
| 2 | Trip organizer | share a wallet pass link for a hotel booking | my co-travelers can add the check-in info to their phones without needing an account |
| 3 | Traveler | receive an updated pass when the gate or time changes | my wallet card always reflects the latest info |
| 4 | Trip viewer | download a pass for any itinerary item I can see | I have offline access to booking details |
| 5 | Pass recipient (no account) | open a share link on my iPhone | the pass is added to my Apple Wallet in one tap |
| 6 | Pass recipient (non-iOS) | open a share link on Android/desktop | I see a web preview of the booking details with a download option |

---

## 3. Pass Type Mapping

Apple Wallet supports several pass styles. Each itinerary type maps to the most appropriate style:

| Itinerary Type | Pass Style | Transit Type | Rationale |
|---------------|-----------|-------------|-----------|
| **Flight** | `boardingPass` | `PKTransitTypeAir` | Standard for air travel; supports departure/arrival fields natively |
| **Rail** | `boardingPass` | `PKTransitTypeTrain` | Native train pass layout with station fields |
| **Transport** | `boardingPass` | `PKTransitTypeBus` / `PKTransitTypeBoat` / `PKTransitTypeGeneric` | Chosen dynamically based on `transportType` field |
| **Lodging** | `generic` | -- | No transit type; hotel/lodging passes use the generic layout |
| **Car** | `generic` | -- | Rental pickup/dropoff displayed as primary/secondary fields |
| **Restaurant** | `eventTicket` | -- | Event ticket style suits time-bound reservations |
| **Activity** | `eventTicket` | -- | Event ticket style with venue/time prominence |

---

## 4. Pass Content Mapping

### 4.1 Flight Pass (boardingPass)

```
HEADER
  [Airline Logo]                    Flight Status Badge
  
TRANSIT FIELDS
  SFO ---------> JFK
  Departure      Arrival
  
PRIMARY FIELDS
  Departure Time    Arrival Time
  
SECONDARY FIELDS
  Flight        Confirmation    Seat        Terminal/Gate
  UA 354        ABC123          12A         (if available)

AUXILIARY FIELDS
  Fare Class    Baggage         Passenger
  Economy       1 carry-on      Jane Doe

BACK FIELDS
  Full trip name, notes, booking agency, total cost,
  cancellation policy, all leg details for multi-leg flights
```

**Field mapping:**

| Pass Field | Source |
|-----------|--------|
| Header - logo text | `content.legs[0].airline` |
| Transit - from | `content.legs[0].departureAirport` |
| Transit - to | `content.legs[-1].arrivalAirport` (last leg) |
| Primary - departure time | `content.legs[0].departureTime` + `departureTimeTz` |
| Primary - arrival time | `content.legs[-1].arrivalTime` + `arrivalTimeTz` |
| Secondary - flight number | `content.legs[0].flightNumber` (or summary for multi-leg) |
| Secondary - confirmation | `confirmationNumber` |
| Secondary - seat | `content.legs[0].seatAssignments` (matched to traveler) |
| Auxiliary - fare class | `content.legs[0].fareClass` |
| Auxiliary - baggage | `content.legs[0].baggageAllowance` |
| Auxiliary - passenger | Traveler name (from query param or first traveler) |
| Relevant date | `content.legs[0].departureTime` (triggers lock-screen surfacing) |
| Relevant locations | Departure and arrival airport coordinates (geocoded) |

**Multi-leg flights:** One pass is generated per leg if the user requests per-leg passes, or a single summary pass for the full itinerary. Default is one pass per itinerary item using the first/last leg for the summary view, with all legs detailed on the back.

### 4.2 Rail Pass (boardingPass)

| Pass Field | Source |
|-----------|--------|
| Transit - from | `content.departureStation` |
| Transit - to | `content.arrivalStation` |
| Primary - departure time | `content.departureTime` + `departureTimeTz` |
| Primary - arrival time | `content.arrivalTime` + `arrivalTimeTz` |
| Secondary - train number | `content.trainNumber` |
| Secondary - operator | `content.trainOperator` |
| Secondary - confirmation | `confirmationNumber` |
| Auxiliary - seat | `content.seatAssignments` (matched to traveler) |
| Auxiliary - carriage | `content.seatAssignments[].carriageNumber` |
| Auxiliary - passenger | Traveler name |
| Relevant date | `content.departureTime` |

### 4.3 Transport Pass (boardingPass)

| Pass Field | Source |
|-----------|--------|
| Transit - from | `content.departureLocation` |
| Transit - to | `content.arrivalLocation` |
| Primary - departure time | `content.departureTime` + `departureTimeTz` |
| Primary - arrival time | `content.arrivalTime` + `arrivalTimeTz` |
| Secondary - type | `content.transportType` |
| Secondary - operator | `content.operator` |
| Secondary - confirmation | `confirmationNumber` |
| Auxiliary - seat | `content.seatAssignments` (if present) |
| Auxiliary - passenger | Traveler name |
| Relevant date | `content.departureTime` |

### 4.4 Lodging Pass (generic)

```
HEADER
  [Property Logo/Icon]            Check-in Date

PRIMARY FIELDS
  Property Name

SECONDARY FIELDS
  Check-in         Check-out        Confirmation
  Mar 15, 3:00 PM  Mar 18, 11:00 AM ABC123

AUXILIARY FIELDS
  Room Type        Guests           Guest Name
  Deluxe King      2                Jane Doe

BACK FIELDS
  Full address, board basis, arrival/departure times,
  notes, total cost, cancellation policy
```

| Pass Field | Source |
|-----------|--------|
| Primary - property name | `content.propertyName` |
| Secondary - check-in | `content.checkInTime` + `checkInTimeTz` (or `checkInDate`) |
| Secondary - check-out | `content.checkOutTime` + `checkOutTimeTz` (or `checkOutDate`) |
| Secondary - confirmation | `confirmationNumber` |
| Auxiliary - room type | `content.roomType` |
| Auxiliary - guests | `content.numberOfGuests` |
| Auxiliary - guest name | Traveler name |
| Relevant date | `content.checkInTime` or `content.checkInDate` |
| Relevant locations | Property address (geocoded) |

### 4.5 Car Rental Pass (generic)

| Pass Field | Source |
|-----------|--------|
| Primary - rental company | `content.rentalCompany` |
| Secondary - pick-up | `content.pickUpTime` + `pickUpTimeTz` |
| Secondary - drop-off | `content.dropOffTime` + `dropOffTimeTz` |
| Secondary - confirmation | `confirmationNumber` |
| Auxiliary - vehicle | `content.vehicleType` |
| Auxiliary - transmission | `content.transmissionType` |
| Auxiliary - driver | Traveler name + `driverRole` |
| Relevant date | `content.pickUpTime` |
| Relevant locations | Pick-up location (geocoded) |
| Back fields | Pick-up/drop-off locations, mileage policy, notes, total cost |

### 4.6 Restaurant Pass (eventTicket)

| Pass Field | Source |
|-----------|--------|
| Primary - restaurant name | `content.restaurantName` |
| Secondary - reservation time | `content.reservationTime` + `reservationTimeTz` |
| Secondary - party size | `content.partySize` |
| Secondary - confirmation | `confirmationNumber` |
| Auxiliary - guest name | Traveler name |
| Relevant date | `content.reservationTime` |
| Relevant locations | Restaurant address (geocoded) |
| Back fields | Full address, notes |

### 4.7 Activity Pass (eventTicket)

| Pass Field | Source |
|-----------|--------|
| Primary - activity name | `content.name` |
| Secondary - start time | `content.startTime` + `content.startTimeTz` |
| Secondary - end time | `content.endTime` + `content.endTimeTz` (if present) |
| Secondary - confirmation | `confirmationNumber` |
| Auxiliary - location | `content.location` |
| Auxiliary - attendee | Traveler name |
| Relevant date | `content.startTime` |
| Relevant locations | Activity location (geocoded) |
| Back fields | Notes, total cost |

---

## 5. Pass Visual Design

### 5.1 Color Scheme

Each itinerary type gets a distinct pass color to make them visually distinguishable in the wallet:

| Type | Background Color | Foreground/Label Color |
|------|-----------------|----------------------|
| Flight | `#1a56db` (deep blue) | `#ffffff` |
| Rail | `#047857` (emerald) | `#ffffff` |
| Transport | `#6d28d9` (violet) | `#ffffff` |
| Lodging | `#b45309` (amber) | `#ffffff` |
| Car | `#0e7490` (cyan) | `#ffffff` |
| Restaurant | `#be123c` (rose) | `#ffffff` |
| Activity | `#c2410c` (orange) | `#ffffff` |

### 5.2 Icons & Images

- **Logo** (`logo.png`, `logo@2x.png`): The Trips app logo, included in all passes.
- **Icon** (`icon.png`, `icon@2x.png`): A small icon representing the itinerary type (plane, bed, train, car, utensils, map-pin, bus).
- **Strip image** (for `eventTicket` and `generic` styles): A subtle branded strip image.
- **Footer** (`footer.png`): Optional -- could display the airline or operator logo if available in a future version.

### 5.3 Relevance & Lock Screen

Each pass includes:
- **`relevantDate`**: The primary date/time for the booking (departure, check-in, reservation time). iOS surfaces the pass on the lock screen approximately 1-2 hours before this time.
- **`locations`** (optional, v2): GPS coordinates for the venue/airport/station. When the user is near the location, the pass appears on the lock screen. Requires geocoding infrastructure.

---

## 6. API Design

### 6.1 Generate & Download Pass

```
GET /trips/:tripId/itineraries/:itineraryId/wallet-pass
```

**Query parameters:**
| Param | Type | Default | Description |
|-------|------|---------|------------|
| `travelerId` | string (UUID) | first traveler | Generate the pass personalized for this specific traveler |
| `legIndex` | number | -- | For multi-leg flights, generate a pass for a specific leg |

**Response:**
- `Content-Type: application/vnd.apple.pkpass`
- `Content-Disposition: attachment; filename="flight-ua354-sfo-jfk.pkpass"`
- Body: the signed `.pkpass` binary

**Auth:** Requires trip participant access (any role).

**Error cases:**
- `404` if trip or itinerary not found
- `403` if user is not a participant
- `400` if itinerary type is not supported (all types are supported, but content validation may fail)

### 6.2 Share Pass (Public Link)

```
POST /trips/:tripId/itineraries/:itineraryId/wallet-pass/share
```

**Request body:**
```json
{
  "travelerId": "uuid-optional",
  "legIndex": 0,
  "expiresInHours": 168
}
```

**Response:**
```json
{
  "shareUrl": "https://trips.example.com/pass/abc123def456",
  "expiresAt": "2026-06-01T00:00:00Z",
  "token": "abc123def456"
}
```

**Auth:** Requires trip participant access with Editor or Owner role.

### 6.3 Redeem Shared Pass

```
GET /pass/:token
```

**No authentication required.** This is a public endpoint.

**Behavior by user agent:**
- **iOS Safari / compatible browsers**: Returns the `.pkpass` file directly (`application/vnd.apple.pkpass`). iOS prompts "Add to Apple Wallet" natively.
- **Other browsers (Accept: text/html)**: Returns an HTML preview page showing the booking details with a download button and "Add to Apple Wallet" badge linking to the `.pkpass` download.

**Token validation:**
- Returns `404` if token is invalid or expired.
- Each token maps to a specific itinerary + traveler + leg combination.

### 6.4 Pass Update Registration (v1 polling)

```
GET /pass/:token/latest
```

Apple Wallet periodically calls the `webServiceURL` registered in the pass to check for updates. In v1, this endpoint returns the latest version of the pass if the itinerary has been modified since the pass was last downloaded. The standard Apple Wallet web service endpoints are:

```
POST   /wallet/v1/devices/:deviceId/registrations/:passTypeId/:serialNumber
DELETE /wallet/v1/devices/:deviceId/registrations/:passTypeId/:serialNumber  
GET    /wallet/v1/devices/:deviceId/registrations/:passTypeId
GET    /wallet/v1/passes/:passTypeId/:serialNumber
```

These follow the [Apple PassKit Web Service](https://developer.apple.com/documentation/walletpasses/adding-a-web-service-to-update-passes) specification.

---

## 7. Data Model Changes

### 7.1 New Table: `wallet_passes`

Tracks issued passes for update support and share link management.

| Column | Type | Description |
|--------|------|------------|
| `id` | TEXT (UUID) PK | Unique pass identifier |
| `tripId` | TEXT FK → trips | Parent trip |
| `itineraryId` | TEXT FK → itineraries | Source itinerary |
| `travelerId` | TEXT | Participant ID the pass is personalized for (nullable) |
| `legIndex` | INTEGER | Flight leg index (nullable, for multi-leg flights) |
| `serialNumber` | TEXT UNIQUE | Apple pass serial number (UUID) |
| `authToken` | TEXT | Authentication token for Apple web service callbacks |
| `shareToken` | TEXT UNIQUE | Public share link token (nullable if not shared) |
| `shareExpiresAt` | TEXT | Share link expiration (nullable) |
| `lastGeneratedAt` | TEXT | When the pass was last built |
| `itineraryUpdatedAt` | TEXT | The `updatedAt` of the itinerary at generation time (for staleness detection) |
| `createdAt` | TEXT | Row creation timestamp |

### 7.2 New Table: `wallet_device_registrations`

Tracks which devices have registered for pass updates (Apple Wallet web service protocol).

| Column | Type | Description |
|--------|------|------------|
| `id` | TEXT (UUID) PK | Row ID |
| `deviceId` | TEXT | Device library identifier (from Apple) |
| `passId` | TEXT FK → wallet_passes | Which pass is registered |
| `pushToken` | TEXT | APNs push token for update notifications (v2) |
| `createdAt` | TEXT | Registration timestamp |

Unique constraint on `(deviceId, passId)`.

---

## 8. Sharing Flow

### 8.1 Authenticated User (In-App)

```
User views itinerary detail
  → Taps "Add to Wallet" button
    → (Optional) Selects traveler if multiple travelers on booking
    → (Optional) Selects leg if multi-leg flight
  → API generates .pkpass file
  → Browser downloads / iOS prompts "Add to Apple Wallet"
```

### 8.2 Share with Others

```
User views itinerary detail
  → Taps "Share Wallet Card" button
    → (Optional) Selects traveler / leg
    → Confirms share (creates time-limited public link)
  → Share sheet appears with link + copy button
  → Recipient opens link on iPhone
    → Pass auto-downloads → "Add to Apple Wallet" prompt
  → Recipient opens link on other device
    → Web preview with booking details + download button
```

### 8.3 Share Link Preview Page (Non-iOS Fallback)

When a share link is opened on a non-iOS device or desktop browser, a lightweight HTML page is rendered server-side showing:

- Itinerary type icon and color header
- Booking headline (flight number, hotel name, etc.)
- Key details (dates, times, locations)
- Confirmation number
- Traveler name
- "Download .pkpass" button
- "Add to Apple Wallet" badge (links to .pkpass download)
- Trip name and app branding in footer

This page requires **no authentication** and **no JavaScript** -- it is a simple server-rendered HTML page.

---

## 9. Frontend UI

### 9.1 Itinerary Detail - Wallet Actions

On the `TripDetail` page, each itinerary card in the timeline gets a wallet action area:

```
┌──────────────────────────────────────────┐
│  ✈  UA 354 · SFO → JFK                  │
│  Mar 15, 2026 · 8:30 AM - 5:15 PM       │
│  Confirmed · ABC123                      │
│                                          │
│  Jane Doe (12A) · John Doe (12B)         │
│                                          │
│  ┌─────────────────┐  ┌───────────────┐  │
│  │ Add to Wallet   │  │ Share Card    │  │
│  └─────────────────┘  └───────────────┘  │
└──────────────────────────────────────────┘
```

- **"Add to Wallet"** button: Visible to all participants. Downloads the `.pkpass` file directly.
- **"Share Card"** button: Visible to Editors and Owners. Opens a share dialog.

### 9.2 Share Dialog

A modal dialog for configuring and sharing the wallet pass link:

```
┌─────────────────────────────────────┐
│  Share Wallet Card                  │
│                                     │
│  Traveler:  [Jane Doe         ▼]   │
│  Leg:       [SFO → JFK       ▼]   │ (only for multi-leg flights)
│                                     │
│  Link expires in: [7 days    ▼]    │
│                                     │
│  ┌─────────────────────────────┐   │
│  │ https://trips.../pass/abc.. │ Copy │
│  └─────────────────────────────┘   │
│                                     │
│  [Generate Link]    [Cancel]        │
└─────────────────────────────────────┘
```

After the link is generated:
- **Copy button** copies the URL to clipboard.
- On mobile, a native share sheet can also be triggered.
- The generated link is shown until the modal is dismissed.

### 9.3 Traveler Selection

If an itinerary has multiple travelers and the user clicks "Add to Wallet," a small inline picker appears:

```
Add to Wallet for:
  ○ Jane Doe (you)
  ○ John Doe
  ○ All travelers (generates one per traveler, downloads as zip)
```

Default: the current user if they are a traveler on the booking, otherwise the first traveler.

---

## 10. Technical Architecture

### 10.1 Pass Signing

Apple Wallet passes must be cryptographically signed. This requires:

1. **Pass Type ID Certificate** -- obtained from the Apple Developer portal. Identifies the pass type (e.g., `pass.com.trips.booking`).
2. **WWDR Intermediate Certificate** -- Apple's Worldwide Developer Relations certificate.
3. **Private Key** -- the private key paired with the Pass Type ID certificate.

These are stored as **Cloudflare Worker secrets** (base64-encoded):

| Secret Name | Content |
|------------|---------|
| `WALLET_PASS_CERTIFICATE` | Pass Type ID certificate (PEM, base64) |
| `WALLET_PASS_PRIVATE_KEY` | Private key (PEM, base64) |
| `WALLET_PASS_WWDR_CERT` | WWDR intermediate certificate (PEM, base64) |

### 10.2 .pkpass File Structure

A `.pkpass` file is a ZIP archive containing:

```
pass.pkpass/
  ├── pass.json          # Pass content and structure
  ├── manifest.json      # SHA-256 hashes of all files
  ├── signature           # PKCS#7 detached signature of manifest.json
  ├── icon.png            # Required icon (29x29)
  ├── icon@2x.png         # Retina icon (58x58)
  ├── logo.png            # Logo displayed on pass (160x50 max)
  ├── logo@2x.png         # Retina logo
  └── strip.png           # Strip image for eventTicket/generic (375x123)
      strip@2x.png
```

### 10.3 Generation Pipeline

```
Request received
  → Validate auth + load itinerary from DB
  → Select pass template based on itinerary type
  → Map itinerary fields → pass.json fields
  → Populate pass.json with:
      - serialNumber (UUID)
      - teamIdentifier (from cert)
      - passTypeIdentifier (from cert)
      - organizationName ("Trips")
      - webServiceURL (for updates)
      - authenticationToken (random, stored in DB)
      - relevantDate
      - type-specific fields (headerFields, primaryFields, etc.)
  → Bundle static assets (icons, logos) + pass.json into ZIP
  → Compute SHA-256 of each file → manifest.json
  → Sign manifest.json with PKCS#7 using certificate + private key
  → Add manifest.json + signature to ZIP
  → Store pass record in wallet_passes table
  → Return ZIP as response with correct MIME type
```

### 10.4 Cloudflare Workers Considerations

- **Crypto**: Use Web Crypto API for SHA-256 hashing. For PKCS#7 signing, use a WASM-compiled signing module or the `pkcs7` npm package adapted for Workers.
- **ZIP creation**: Use a lightweight library like `fflate` (works in Workers, no Node.js dependencies).
- **Static assets**: Pass images (icons, logos) are bundled as base64 strings in the Worker code or stored in Cloudflare R2 and fetched at generation time.
- **CPU limits**: Pass generation involves hashing and signing. Keep operations efficient; the 30ms CPU time limit on Workers may require optimization or using Cloudflare Workers Unbound (no CPU limit).

### 10.5 Recommended Library

Use **`passkit-generator`** concepts but implement a lightweight, Workers-compatible pass builder since `passkit-generator` depends on Node.js `crypto` and `fs` modules. The custom builder needs:

1. A `PassBuilder` class that constructs `pass.json` from itinerary data.
2. A `PassSigner` module that creates the PKCS#7 signature using Web Crypto + a lightweight ASN.1/PKCS#7 library.
3. A `PassBundler` that creates the ZIP archive using `fflate`.

---

## 11. Security Considerations

| Concern | Mitigation |
|---------|-----------|
| Share links expose booking data | Tokens are cryptographically random (256-bit), time-limited (default 7 days), and revocable |
| Confirmation numbers are sensitive | Share links include confirmation numbers -- this is intentional since recipients need them. The share dialog warns: "This link will include your confirmation number." |
| Pass signing keys | Stored as Cloudflare Worker secrets, never exposed in responses or logs |
| Enumeration of share tokens | Tokens are 256-bit random; rate limiting on `/pass/:token` endpoint |
| Pass update auth tokens | Per-pass random tokens; validated on every web service callback |
| Expired shares | Background cleanup job (Cloudflare Cron Trigger) purges expired share tokens weekly |
| Access control | Pass generation requires trip participant access; share creation requires Editor/Owner role |

---

## 12. Implementation Phases

### Phase 1: Core Pass Generation
- Implement `PassBuilder` for all 7 itinerary types
- Implement `PassSigner` (PKCS#7 signing for Workers)
- Implement `PassBundler` (ZIP creation)
- Add `GET /trips/:tripId/itineraries/:itineraryId/wallet-pass` endpoint
- Add "Add to Wallet" button to frontend itinerary cards
- Create `wallet_passes` database table and migration
- Design and bundle pass icon/logo assets

### Phase 2: Share Links
- Add `wallet_passes` share token columns
- Implement `POST .../wallet-pass/share` endpoint
- Implement `GET /pass/:token` public endpoint
- Build server-rendered HTML preview page for non-iOS fallback
- Add "Share Card" button + share dialog to frontend
- Implement share link expiration and cleanup

### Phase 3: Pass Updates
- Implement Apple Wallet web service endpoints (register, unregister, list, fetch)
- Add `wallet_device_registrations` table
- Detect itinerary changes and serve updated passes
- Add `updatedAt` comparison logic for staleness detection

### Phase 4: Enhancements
- Location-based relevance (geocoding addresses to coordinates)
- Per-leg pass generation for multi-leg flights
- Bulk download (all passes for a trip as ZIP)
- Pass revocation (when itinerary is deleted or cancelled)
- Google Wallet support

---

## 13. Open Questions

1. **Apple Developer Account**: Is there an existing Apple Developer account with Pass Type ID capability, or does one need to be provisioned?
2. **Workers CPU Limits**: Should we use Cloudflare Workers Unbound for pass generation, or can signing be optimized to fit within the standard 10ms CPU limit? Initial testing needed.
3. **Pass images**: Should we invest in per-airline/per-hotel-chain logo images, or use generic type-based icons only?
4. **Geocoding provider**: For location-based lock-screen surfacing, which geocoding service should we use for converting addresses to coordinates?
5. **Share link domain**: Should share links use the main app domain (`trips.example.com/pass/...`) or a dedicated short domain?
