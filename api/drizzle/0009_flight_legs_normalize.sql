-- Normalize flight itineraries: move top-level per-leg fields into the legs array.
-- Old format: top-level airline/flightNumber/etc for first leg, optional legs[] for additional.
-- New format: all legs in legs[], only travelers at the top level.

-- Case 1: Single-leg flights (no legs array) — wrap top-level fields as legs[0]
UPDATE itineraries
SET content = json_object(
  'travelers', json_extract(content, '$.travelers'),
  'legs', json_array(
    json_object(
      'airline', json_extract(content, '$.airline'),
      'flightNumber', json_extract(content, '$.flightNumber'),
      'departureAirport', json_extract(content, '$.departureAirport'),
      'departureTime', json_extract(content, '$.departureTime'),
      'departureTimeTz', json_extract(content, '$.departureTimeTz'),
      'arrivalAirport', json_extract(content, '$.arrivalAirport'),
      'arrivalTime', json_extract(content, '$.arrivalTime'),
      'arrivalTimeTz', json_extract(content, '$.arrivalTimeTz'),
      'fareClass', json_extract(content, '$.fareClass'),
      'baggageAllowance', json_extract(content, '$.baggageAllowance'),
      'seatAssignments', json_extract(content, '$.seatAssignments')
    )
  )
)
WHERE type = 'Flight'
  AND json_extract(content, '$.legs') IS NULL;

-- Case 2: Multi-leg flights (has legs array) — prepend top-level fields as legs[0],
-- rename cabinClass→fareClass in existing legs, strip top-level flight fields.
UPDATE itineraries
SET content = json_object(
  'travelers', json_extract(content, '$.travelers'),
  'legs', json(
    '[' ||
    json_object(
      'airline', json_extract(content, '$.airline'),
      'flightNumber', json_extract(content, '$.flightNumber'),
      'departureAirport', json_extract(content, '$.departureAirport'),
      'departureTime', json_extract(content, '$.departureTime'),
      'departureTimeTz', json_extract(content, '$.departureTimeTz'),
      'arrivalAirport', json_extract(content, '$.arrivalAirport'),
      'arrivalTime', json_extract(content, '$.arrivalTime'),
      'arrivalTimeTz', json_extract(content, '$.arrivalTimeTz'),
      'fareClass', json_extract(content, '$.fareClass'),
      'baggageAllowance', json_extract(content, '$.baggageAllowance'),
      'seatAssignments', json_extract(content, '$.seatAssignments')
    ) ||
    ',' ||
    substr(
      (SELECT json_group_array(
        json_object(
          'airline', json_extract(leg.value, '$.airline'),
          'flightNumber', json_extract(leg.value, '$.flightNumber'),
          'departureAirport', json_extract(leg.value, '$.departureAirport'),
          'departureTime', json_extract(leg.value, '$.departureTime'),
          'departureTimeTz', json_extract(leg.value, '$.departureTimeTz'),
          'arrivalAirport', json_extract(leg.value, '$.arrivalAirport'),
          'arrivalTime', json_extract(leg.value, '$.arrivalTime'),
          'arrivalTimeTz', json_extract(leg.value, '$.arrivalTimeTz'),
          'fareClass', COALESCE(json_extract(leg.value, '$.fareClass'), json_extract(leg.value, '$.cabinClass')),
          'baggageAllowance', json_extract(leg.value, '$.baggageAllowance'),
          'seatAssignments', json_extract(leg.value, '$.seatAssignments')
        )
      ) FROM json_each(json_extract(itineraries.content, '$.legs')) AS leg),
      2  -- skip leading '[', keeps trailing ']'
    )
  )
)
WHERE type = 'Flight'
  AND json_extract(content, '$.legs') IS NOT NULL;
