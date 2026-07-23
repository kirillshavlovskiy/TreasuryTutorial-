# FXAll Integration

> Source: https://wiki.deel.network/i/14521
> Last updated: 2026-03-05

## Create the FXAll Adapter in fin-info-ex

Create the FXAll adapter in the `fin-info-ex` service the same way JPMorgan/Citi are integrated now (Request Quote).

- The protocol might be Market Data and not Request Quote, so a new integration might be needed.

## Create the FXAll Adapter in fx-rate-mesh

Create a cron in the `fx-rate-mesh` service that requests quotes from `fin-info-ex` every 10 minutes, polls the response, and saves it in cache.

After data is saved, it can be returned to clients in the same way it is returned now via API request/response.

## V2 API in fx-rate-mesh

The current v1 structure returns only midpoint rates, which is good for most cases. A new structure is needed that can also include bid/ask rate.

### Proposed Solution

**URL**

Current:
```
/api/v1/latest
```

New:
```
/api/v2/latest
```

**Request** — remains the same

**Response**

Current (v1):
```json
{
    "sourceCurrency": "USD",
    "rates": {
        "EUR": 0.93
    },
    "providers": {
        "EUR": "Oanda"
    },
    "timestamp": 1707826978496,
    "skippedRates": {}
}
```

New (v2):
```json
{
    "sourceCurrency": "USD",
    "rates": {
        "EUR": {
            "bid": 0.92,
            "ask": 0.94,
            "midpoint": 0.93
        }
    },
    "providers": {
        "EUR": "Oanda"
    },
    "timestamp": 1707826978496,
    "skippedRates": {}
}
```
