# FX Rate Mesh

> Source: internal wiki (FX Rate Mesh)
> Last updated: 2026-03-05

## Overview

This service improves the way internal services interact with FX Rate Providers (XE, Oanda, etc.).

## Requirements

1. Handle errors or big latencies from FX Providers
2. Handle abnormal rate from FX Providers
3. Reduce quota usage to FX Providers while being able to scale

## Features

1. **Define Provider Priority per Symbol** — In case one provider returns an abnormal rate for one symbol, a new Provider can be prioritised for that symbol
2. **Optimise quota usage** — Cache for latest rates (10min); return historical data from database
3. **Alerts for abnormal rate change** — +/- 1% in a 15min timeframe for latest rates

## FX Providers

Any provider can be added using adapter pattern. Currently integrated providers:

1. **Refinitiv (LSEG)** — Primary provider for all FX rates. SOC2 compliant.
   - Spot FX rates (Fiat and Crypto)
   - Historical Spot FX rates (Fiat and Crypto)
   - Daily Central Bank Rates (Fiat)
   - Historical Central Bank Rates (Fiat)

2. **XE** — Fallback provider for Fiat FX rates.
   - Spot FX rates (Fiat)
   - Daily Central Bank Rates (Fiat)
   - Historical Central Bank Rates (Fiat)

3. **Coinbase** — Crypto rates only; fallback when Refinitiv unavailable.
   - Spot FX rates (Crypto)
   - Historical Spot FX rates (Crypto)

## How to Use It

The service is available cluster-only in each environment (Giger, dev, prod): `http://fx-rate-mesh`

Use OpenLens/Kubectl port-forward to access it and read docs: `http://fx-rate-mesh/docs`

For Node.js integration use the OpenAPI lib published on AWS CodeArtifact:

```bash
npm install fx-rate-mesh-node-client
```

```js
const {FXRateApi} = require('fx-rate-mesh-node-client');
const fxRateClient = new FXRateApi(new Configuration(), 'http://fx-rate-mesh');

const base = 'USD';
const symbols = ['EUR', 'CAD'];
const res = await fxRateClient.getLatest({base, symbols});
```

## Central Bank Exchange Rates

### Usage

```js
const {FXRateApi} = require('fx-rate-mesh-node-client');
const fxRateClient = new FXRateApi(new Configuration(), 'http://fx-rate-mesh');

const date = '2024-05-27';
const centralBankCode = 'POL';
const destinationCurrency = ['PLN']; // optional — if empty returns all rates for the specified date/central bank
const res = await fxRateClient.getCentralBankExchangeRate(centralBankCode, destinationCurrency, date);
```

### Expected Result

```json
{
    "rates": [
        {
            "date": "2024-05-27",
            "sourceCurrency": "EUR",
            "destinationCurrency": "PLN",
            "mid": 4.2528,
            "ask": null,
            "bid": null
        }
    ],
    "providers": {
        "PLN": "Refinitive"
    },
    "centralBankCode": "POL",
    "centralBankName": "National Bank of Poland",
    "skippedRates": {}
}
```

### Available Central Banks

| Code  | Country              | Financial Institution                         | Available pairs  | Comment |
|-------|----------------------|-----------------------------------------------|------------------|---------|
| ARG   | Argentina            | National Bank of Argentina                    | USD/ARS          | |
| BCRA  | Argentina            | Central Bank of Argentina                     | USD/ARS          | |
| AUS   | Australia            | Reserve Bank of Australia                     | USD/AUD          | |
| BRA   | Brazil               | Central Bank of Brazil                        | USD/BRL          | |
| BGR   | Bulgaria             | Bulgarian National Bank                       | EUR/BGN, USD/BGN | |
| CAN   | Canada               | Bank of Canada                                | USD/CAD          | Indicative daily average rate — not an official CAD FX Fixing |
| CRI   | Costa Rica           | Central Bank of Costa Rica                    | USD/CRC          | |
| DNK   | Denmark              | National Bank of Denmark                      | USD/DKK          | |
| EGY   | Egypt                | Central Bank of Egypt                         | USD/EGP          | |
| ETH   | Ethiopia             | Ethiopian National Bank                       | USD/ETB          | |
| ECB   | European Union       | European Central Bank                         | USD/EUR          | Covers all 20 eurozone member states |
| HKG   | Hong Kong            | —                                             | —                | HKD currency pairs currently not supported |
| HND   | Honduras             | Honduras Central Bank                         | USD/HNL          | |
| IDN   | Indonesia            | Bank Indonesia                                | USD/IDR          | |
| ISR   | Israel               | Bank of Israel                                | USD/ILS          | |
| JPN   | Japan                | Bank of Japan                                 | USD/JPY          | |
| KEN   | Kenya                | Central Bank of Kenya                         | USD/KES          | |
| MYS   | Malaysia             | Bank Negara Malaysia                          | USD/MYR          | |
| NGA   | Nigeria              | Central Bank of Nigeria                       | USD/NGN          | |
| NZFMA | New Zealand         | New Zealand Financial Markets Association     | USD/NZD          | Published by NZFMA, not RBNZ |
| PER   | Peru                 | Central Reserve Bank of Peru                  | USD/PEN          | |
| POL   | Poland               | National Bank of Poland                       | EUR/PLN          | |
| PRY   | Paraguay             | Central Bank of Paraguay                      | USD/PYG          | |
| ROU   | Romania              | National Bank of Romania                      | USD/RON          | |
| SGP   | Singapore            | ABS Association of Banks in Singapore         | USD/SGD          | Rates from ABS, not MAS |
| SWE   | Sweden               | Sveriges Riksbank                             | EUR/SEK          | |
| CHE   | Switzerland          | Swiss National Bank                           | EUR/CHF          | |
| TFI   | Taiwan               | Taipei Forex Inc.                             | USD/TWD          | Not the Central Bank |
| TUR   | Turkey               | Central Bank of the Republic of Turkey        | EUR/TRY          | |
| URY   | Uruguay              | Central Bank of Uruguay                       | USD/UYU          | |
| ARE   | United Arab Emirates | Central Bank of the UAE                       | USD/AED          | |
| GBR   | United Kingdom       | Bank of England                               | USD/GBP, CHF/GBP | |
| ZAF   | South Africa         | South African Reserve Bank                    | USD/ZAR          | |

### Adding New Banks

If the required Central Bank or currency pair is not listed, reach out to the Treasury team (contact: @Dorde Milosevic). Each new Central Bank or currency pair must be configured within Refinitiv to become available in the internal API.

## UI

- FX Rates: internal Treasury admin → FX Rates
- Provider Priorities: internal Treasury admin → FX Rates Provider Priorities

## Tasks

### Daily

1. Fetch historical data at end of day (**23:30 GMT**). One request made; data saved in database for USD → all symbols. Any currency pair without USD as source (e.g. EUR → CAD) is computed from saved data.

## Monitoring

- Datadog Dashboard: `https://app.datadoghq.eu/dashboard/ypg-bzb-zkb/fx-rate-mesh`
- Sentry: internal Sentry project `fx-rate-mesh`
- Slack: **#alerts-fx-rate** — monitors big changes in currency pairs

## Database Schema

Schema: `fx_rate_mesh`

Tables:
1. `exchange_rates`
2. `provider_priorities`
3. `central_bank_exchange_rates`
