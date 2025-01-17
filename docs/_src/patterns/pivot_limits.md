# Pivot Limits

Or really, limiting results based on secondary queries.

Let's suppose we wanted to look flight data but only at only the top 5 carriers and only the top 5 destinations.

## Carriers by destination produces 1958 rows
```malloy
--! {"isRunnable": true, "runMode": "auto", "source": "faa/flights.malloy", "isPaginationEnabled": true, "pageSize":100, "size":"small"}
explore flights
| reduce
  carriers.nickname
  destination_code
  flight_count
```

## Query for the top 5 carriers
Query to find the most interesting carriers.
```malloy
--! {"isRunnable": true, "runMode": "auto", "source": "faa/flights.malloy", "isPaginationEnabled": true, "pageSize":100, "size":"small"}
explore flights
| reduce top 5
  carriers.nickname
  flight_count
```

## Top 5 Destinstinations
```malloy
--! {"isRunnable": true, "runMode": "auto", "source": "faa/flights.malloy", "isPaginationEnabled": true, "pageSize":100, "size":"small"}
explore flights
| reduce top 5
  destination_code
  flight_count
```

## Run all three queries together as Aggregating Subqueries.
Produces a table with a single row and three columns.  Each column essentially contains a table
```malloy
--! {"isRunnable": true, "runMode": "auto", "source": "faa/flights.malloy", "isPaginationEnabled": true, "pageSize":100, "size":"small"}
explore flights
| reduce
  main_query is (reduce
    carriers.nickname
    destination_code
    flight_count
  )
  top_carriers is (reduce top 5
    carriers.nickname
    flight_count
  )
  top_destinations is (reduce top 5
    destination_code
    flight_count
  )
```

## Project the main query and use the *top* nested queries to limit the results
Project produces a cross join of the tables.  The filter essentially does an inner join, limiting the main queries results to
dimensional values that are produce in the filtering queries.
```malloy
--! {"isRunnable": true, "runMode": "auto", "source": "faa/flights.malloy", "isPaginationEnabled": true, "pageSize":100, "size":"small"}
explore flights
| reduce
  main_query is (reduce
    carriers.nickname
    destination_code
    flight_count
  )
  top_carriers is (reduce top 5
    carriers.nickname
    flight_count
  )
  top_destinations is (reduce top 5
    destination_code
    flight_count
  )
| project : [
    main_query.nickname = top_carriers.nickname,
    main_query.destination_code = top_destinations.destination_code
  ]
  main_query.*
```

## Render the results as a pivot table
```malloy
--! {"isRunnable": true, "runMode": "auto", "source": "faa/flights.malloy", "isPaginationEnabled": true, "pageSize":100, "size":"small"}
explore flights
| reduce
  main_query is (reduce
    carriers.nickname
    destination_code
    flight_count
  )
  top_carriers is (reduce top 5
    carriers.nickname
    flight_count
  )
  top_destinations is (reduce top 5
    destination_code
    flight_count
  )
| reduce : [
    main_query.nickname = top_carriers.nickname,
    main_query.destination_code = top_destinations.destination_code
  ]
  main_query.nickname
  destination_pivot is (project
    main_query.destination_code
    main_query.flight_count
  )
```

## Filtering applies to all the nested queries.
Reusing this query is pretty simple.  In the example below, we filter to California and see the top 5 California Carriers and top 5 Calfornia Destinations.
```malloy
--! {"isRunnable": true, "runMode": "auto", "source": "faa/flights.malloy", "isPaginationEnabled": true, "pageSize":100, "size":"small"}
explore flights : [destination.state:'CA']
| reduce
  main_query is (reduce
    carriers.nickname
    destination_code
    flight_count
  )
  top_carriers is (reduce top 5
    carriers.nickname
    flight_count
  )
  top_destinations is (reduce top 5
    destination_code
    flight_count
  )
| reduce : [
    main_query.nickname = top_carriers.nickname,
    main_query.destination_code = top_destinations.destination_code
  ]
  main_query.nickname
  destination_pivot is (project
    main_query.destination_code
    main_query.flight_count
  )
```