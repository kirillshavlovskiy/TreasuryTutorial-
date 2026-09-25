import { describe, expect, it } from 'vitest';
import { emptyMarketRatesForCcy } from '@/lib/fx-market-rates';
import {
  buildXccyCurvesRequest,
  parseXccyCurvesResponse,
} from '@/lib/refinitivCrossCurrencyCurves';
import { parseXccyDefinitionsResponse } from '@/lib/refinitivXccyDefinitions';
import {
  applyXccyCurveToBundle,
  bookCcyOfSurface,
  bookCcyOfXccy,
  bookCurveRequest,
  chunkIds,
  depositsFromForwardCurves,
  depositsFromXccyCurve,
  fxVolPullBookRequest,
  impliedVolFromSurface,
  pickXccyDefinition,
  swapPointsFromCip,
  swapZcCurveRequest,
  tenorToMonths,
  xccyBookRequest,
  XCCY_CURVE_TENORS,
  xccyCurveDefFromPublished,
  xccyDefinitionQuery,
  xccyIndexFallbacks,
  xccyPairDefinition,
  xccySingleRequest,
} from '@/lib/refinitiv-to-market';

describe('refinitiv-to-market', () => {
  it('maps IPA tenors to months', () => {
    expect(tenorToMonths('1M')).toBe(1);
    expect(tenorToMonths('1Y')).toBe(12);
    expect(tenorToMonths('1W')).toBe(0.25);
    expect(tenorToMonths('ON')).toBeCloseTo(1 / 30, 8);
    expect(tenorToMonths('SW')).toBeCloseTo(7 / 30, 8);
  });

  it('builds CIP points for EURUSD from deposit rates', () => {
    const pts = swapPointsFromCip({
      ccy: 'EUR',
      spotMid: 1.17,
      rFcyPct: 2,
      rUsdPct: 4,
      months: 12,
    });
    expect(pts).toBeDefined();
    expect(pts!.bid).toBeGreaterThan(0);
  });

  it('fills FCY + USD deposit rows from two IPA curves', () => {
    const rows = depositsFromForwardCurves(
      [
        {
          forwardCurveTag: 'EURFwd',
          currency: 'EUR',
          indexName: 'EURIBOR',
          indexTenor: '3M',
          errorMessage: '',
          points: [
            { tenor: '1M', startDate: '', endDate: '', ratePercent: 2.1, discountFactor: null },
            { tenor: '1Y', startDate: '', endDate: '', ratePercent: 2.4, discountFactor: null },
          ],
        },
        {
          forwardCurveTag: 'USDFwd',
          currency: 'USD',
          indexName: 'SOFR',
          indexTenor: '3M',
          errorMessage: '',
          points: [
            { tenor: '1M', startDate: '', endDate: '', ratePercent: 4.1, discountFactor: null },
            { tenor: '1Y', startDate: '', endDate: '', ratePercent: 3.8, discountFactor: null },
          ],
        },
      ],
      'EUR',
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]!.tenor).toBe('1M');
    expect(rows[0]!.eur.creditPct).toBe(2.1);
    expect(rows[0]!.usd.creditPct).toBe(4.1);
    expect(rows[1]!.tenor).toBe('1Y');
  });

  it('reads the ATM row of a Tenor × Delta vol matrix', () => {
    const rec = impliedVolFromSurface({
      surfaceTag: 'FxVol-USDJPY',
      fxCrossCode: 'USDJPY',
      xLabels: ['1M', '3M', '1Y'],
      yLabels: ['10P', '25P', 'ATM', '25C', '10C'],
      values: [
        [0.09, 0.1, 0.11],
        [0.075, 0.08, 0.09],
        [0.061, 0.063, 0.07],
        [0.07, 0.072, 0.08],
        [0.085, 0.09, 0.1],
      ],
      errorMessage: '',
    });
    expect(rec['1']).toBeCloseTo(0.061);
    expect(rec['3']).toBeCloseTo(0.063);
    expect(rec['12']).toBeCloseTo(0.07);
  });

  it('reads the ATM row of a Date × Strike vol matrix', () => {
    const rec = impliedVolFromSurface({
      surfaceTag: 'FxVol-EURUSD',
      fxCrossCode: 'EURUSD',
      xLabels: ['1M', '3M', '1Y'],
      yLabels: ['25D', 'ATM', '25D C'],
      values: [
        [0.08, 0.09, 0.1],
        [0.061, 0.063, 0.07],
        [0.07, 0.08, 0.09],
      ],
      errorMessage: '',
    });
    expect(rec['1']).toBeCloseTo(0.061);
    expect(rec['3']).toBeCloseTo(0.063);
    expect(rec['12']).toBeCloseTo(0.07);
  });

  it('builds one IPA universe item per book pair', () => {
    const req = fxVolPullBookRequest(['JPY', 'EUR', 'PLN'], '2026-08-31');
    expect(req.universe).toHaveLength(3);
    expect(req.universe.map(u => u.underlyingDefinition.fxCrossCode)).toEqual([
      'USDJPY',
      'EURUSD',
      'USDPLN',
    ]);
    expect(req.universe[0]!.surfaceParameters.xAxis).toBe('Tenor');
    expect(req.universe[0]!.surfaceParameters.yAxis).toBe('Delta');
  });

  it('maps a pulled surface back onto the book CCY', () => {
    expect(
      bookCcyOfSurface(
        {
          surfaceTag: 'FxVol-EURUSD',
          fxCrossCode: 'EURUSD',
          xLabels: [],
          yLabels: [],
          values: [],
          errorMessage: '',
        },
        ['JPY', 'EUR', 'PLN'],
      ),
    ).toBe('EUR');
  });

  it('requests OIS for RFR curves and 3M / 28D for IBORs', () => {
    const tenorOf = (ccy: string) =>
      swapZcCurveRequest(ccy, '2026-08-31').universe[0]
        ?.forwardCurveDefinitions[0]?.indexTenor;
    expect(tenorOf('USD')).toBe('OIS');
    expect(tenorOf('GBP')).toBe('OIS');
    expect(tenorOf('JPY')).toBe('OIS');
    expect(tenorOf('TRY')).toBe('OIS');
    expect(tenorOf('EUR')).toBe('3M');
    expect(tenorOf('PLN')).toBe('3M');
    expect(tenorOf('MXN')).toBe('28D');
  });

  it('builds one IPA curve family per CCY including USD', () => {
    const req = bookCurveRequest(['USD', 'JPY', 'EUR'], '2026-08-31');
    expect(req.universe).toHaveLength(3);
    expect(req.universe.map(u => u.curveDefinition.currency)).toEqual([
      'USD',
      'JPY',
      'EUR',
    ]);
  });

  it('chunks IPA surface batches', () => {
    expect(chunkIds(['JPY', 'MXN', 'TRY', 'GBP', 'EUR', 'PLN'], 5)).toEqual([
      ['JPY', 'MXN', 'TRY', 'GBP', 'EUR'],
      ['PLN'],
    ]);
  });

  it('builds IPA XCCY defs as FCY/USD for majors and USD/FCY otherwise', () => {
    expect(xccyPairDefinition('EUR')).toEqual({
      baseCurrency: 'EUR',
      baseIndexName: 'ESTR',
      quotedCurrency: 'USD',
      quotedIndexName: 'SOFR',
      curveTenors: [...XCCY_CURVE_TENORS],
    });
    expect(xccyPairDefinition('JPY')).toEqual({
      baseCurrency: 'USD',
      baseIndexName: 'SOFR',
      quotedCurrency: 'JPY',
      quotedIndexName: 'TONAR',
      curveTenors: [...XCCY_CURVE_TENORS],
    });
    expect(XCCY_CURVE_TENORS.slice(0, 5)).toEqual([
      'SN',
      'SW',
      '2W',
      '3W',
      '1M',
    ]);
  });

  it('builds one XCCY universe item per FCY pair', () => {
    const req = xccyBookRequest(['USD', 'EUR', 'JPY', 'PLN']);
    expect(req.universe).toHaveLength(3);
    expect(req.universe.map(u => u.curveDefinition)).toEqual([
      xccyPairDefinition('EUR'),
      xccyPairDefinition('JPY'),
      xccyPairDefinition('PLN'),
    ]);
    expect(xccyPairDefinition('PLN')).toMatchObject({
      baseCurrency: 'USD',
      baseIndexName: 'LIBOR',
      quotedCurrency: 'PLN',
      quotedIndexName: 'WIBOR',
      mainConstituentAssetClass: 'FxForward',
      name: 'USD PLN FxForward',
      source: 'Refinitiv',
    });
    expect(xccyIndexFallbacks('PLN')).toEqual([
      'WIBOR',
      'WIRON',
      'POLSTR',
      'POLONIA',
    ]);
    expect(xccySingleRequest('PLN', 'WIRON').universe[0]!.curveDefinition)
      .toMatchObject({
        baseIndexName: 'LIBOR',
        quotedIndexName: 'WIRON',
        mainConstituentAssetClass: 'FxForward',
      });
  });

  it('parses the IPA EUR ESTR / USD SOFR cross-currency curve', () => {
    const parsed = parseXccyCurvesResponse({
      data: [
        {
          curveDefinition: {
            baseCurrency: 'EUR',
            baseIndexName: 'ESTR',
            quotedCurrency: 'USD',
            quotedIndexName: 'SOFR',
            crossCurrencyDefinitions: [
              { name: 'EUR ESTR/USD SOFR FxCross' },
            ],
          },
          curveParameters: { valuationDate: '2026-08-31' },
          curve: {
            fxCrossScalingFactor: 1,
            fxSwapPointScalingFactor: 10000,
            curvePoints: [
              {
                tenor: 'SPOT',
                startDate: '2026-09-02',
                endDate: '2026-09-02',
                swapPoint: { bid: 0, ask: 0, mid: 0 },
                outright: { bid: 1.1599, ask: 1.16, mid: 1.15995 },
              },
              {
                tenor: '1M',
                startDate: '2026-09-02',
                endDate: '2026-10-02',
                swapPoint: { bid: 13.37, ask: 13.67, mid: 13.52 },
                outright: { bid: 1.161237, ask: 1.161367, mid: 1.161302 },
              },
              {
                tenor: '12M',
                startDate: '2026-09-02',
                endDate: '2027-09-02',
                swapPoint: { bid: 161.86, ask: 167.04, mid: 164.45 },
                outright: { bid: 1.176086, ask: 1.176704, mid: 1.176395 },
              },
            ],
          },
        },
      ],
    });
    expect(parsed.curves).toHaveLength(1);
    const curve = parsed.curves[0]!;
    expect(curve.baseCurrency).toBe('EUR');
    expect(curve.quotedCurrency).toBe('USD');
    expect(curve.name).toBe('EUR ESTR/USD SOFR FxCross');
    expect(curve.fxSwapPointScalingFactor).toBe(10000);
    const spot = curve.points.find(p => p.tenor === 'SPOT');
    const m1 = curve.points.find(p => p.tenor === '1M');
    expect(spot?.outright.mid).toBeCloseTo(1.15995);
    expect(m1?.swapPoint.bid).toBeCloseTo(13.37);
    expect(m1?.swapPoint.ask).toBeCloseTo(13.67);
    expect(bookCcyOfXccy(curve, ['JPY', 'EUR', 'PLN'])).toBe('EUR');

    const rows = depositsFromXccyCurve(curve);
    expect(rows.map(r => r.tenor)).toEqual(['1M', '1Y']);
    expect(
      depositsFromXccyCurve(
        {
          ...curve,
          points: [
            ...curve.points,
            {
              tenor: 'SN',
              startDate: '',
              endDate: '',
              swapPoint: { bid: 0.43, ask: 0.49, mid: 0.46 },
              outright: { bid: 1.16, ask: 1.16, mid: 1.16 },
            },
          ],
        },
        {
          ...emptyMarketRatesForCcy('EUR'),
          deposits: [
            {
              tenor: 'SW',
              months: 7 / 30,
              eur: { creditPct: 2, debitPct: 2 },
              usd: { creditPct: 4, debitPct: 4 },
            },
            {
              tenor: '1Y',
              months: 12,
              eur: { creditPct: 2, debitPct: 2 },
              usd: { creditPct: 4, debitPct: 4 },
            },
          ],
        },
      ).map(r => r.tenor),
    ).toEqual(['SN', 'SW', '1M', '1Y']);
    expect(rows[0]!.swapPoints?.bid).toBeCloseTo(13.37);
    expect(rows[0]!.swapPoints?.ask).toBeCloseTo(13.67);
    expect(rows[0]!.outright?.bid).toBeCloseTo(1.161237);

    const applied = applyXccyCurveToBundle(
      emptyMarketRatesForCcy('EUR'),
      curve,
      'EUR',
      '2026-08-31',
    );
    expect(applied.spot?.mid).toBeCloseTo(1.15995);
    expect(applied.spot?.bid).toBeCloseTo(1.1599);
    // FxMarketRatesBundle.asOf is optional in general (not every producer sets it), but
    // applyXccyCurveToBundle's own return statement always populates it (lib/refinitiv-to-market.ts).
    expect(applied.asOf!.spotDate).toBe('2026-09-02');
    expect(applied.sourceFile).toContain('EUR ESTR/USD SOFR FxCross');
  });

  it('looks up IPA definitions and prefers Swap over FxForward fallback', () => {
    expect(xccyDefinitionQuery('EUR')).toEqual({
      baseCurrency: 'EUR',
      quotedCurrency: 'USD',
    });
    expect(xccyDefinitionQuery('PLN')).toEqual({
      baseCurrency: 'USD',
      quotedCurrency: 'PLN',
    });
    const listed = parseXccyDefinitionsResponse({
      data: [
        {
          curveDefinitions: [
            {
              baseCurrency: 'USD',
              baseIndexName: 'LIBOR',
              name: 'USD PLN FxForward',
              quotedCurrency: 'PLN',
              quotedIndexName: 'WIBOR',
              source: 'Refinitiv',
              mainConstituentAssetClass: 'FxForward',
              isFallbackForFxCurveDefinition: true,
              id: '389668c4-4301-4fd3-899a-655544a9b463',
            },
          ],
        },
        {
          curveDefinitions: [
            {
              baseCurrency: 'USD',
              baseIndexName: 'SOFR',
              name: 'USD SOFR/MXN TIIE FxCross',
              quotedCurrency: 'MXN',
              quotedIndexName: 'TIIE',
              source: 'Refinitiv',
              mainConstituentAssetClass: 'Swap',
              isFallbackForFxCurveDefinition: false,
              id: '20766358-a71b-4d4a-8825-a701dc4c87cd',
            },
            {
              baseCurrency: 'USD',
              baseIndexName: 'SOFR',
              name: 'USD MXN FxForward',
              quotedCurrency: 'MXN',
              quotedIndexName: 'TIIE',
              source: 'Refinitiv',
              mainConstituentAssetClass: 'FxForward',
              isFallbackForFxCurveDefinition: false,
              id: 'a2dad7bb-d818-4c72-b495-d5b05c4e0d23',
            },
          ],
        },
        {
          curveDefinitions: [
            {
              baseCurrency: 'USD',
              baseIndexName: 'SOFR',
              name: 'USD SOFR/TRY CCS FxCross',
              quotedCurrency: 'TRY',
              quotedIndexName: 'TLREF',
              source: 'Refinitiv',
              mainConstituentAssetClass: 'Swap',
              isFallbackForFxCurveDefinition: false,
              id: '1cd9037b-06b4-42a5-8538-358fb670e2e5',
            },
            {
              baseCurrency: 'USD',
              baseIndexName: 'LIBOR',
              name: 'USD TRY FxCross',
              quotedCurrency: 'TRY',
              quotedIndexName: 'TRYIBOR',
              source: 'Refinitiv',
              mainConstituentAssetClass: 'Swap',
              isFallbackForFxCurveDefinition: true,
              id: '7c210ffe-8c80-4134-9e19-e689454eab7c',
            },
          ],
        },
      ],
    });
    const pln = pickXccyDefinition(listed.rows[0]!.definitions);
    const mxn = pickXccyDefinition(listed.rows[1]!.definitions);
    const tryCcy = pickXccyDefinition(listed.rows[2]!.definitions);
    expect(pln?.name).toBe('USD PLN FxForward');
    expect(pln?.baseIndexName).toBe('LIBOR');
    expect(pln?.quotedIndexName).toBe('WIBOR');
    expect(mxn?.name).toBe('USD SOFR/MXN TIIE FxCross');
    expect(tryCcy?.name).toBe('USD SOFR/TRY CCS FxCross');
    expect(xccyCurveDefFromPublished(pln!)).toEqual({
      baseCurrency: 'USD',
      baseIndexName: 'LIBOR',
      quotedCurrency: 'PLN',
      quotedIndexName: 'WIBOR',
      curveTenors: [...XCCY_CURVE_TENORS],
    });
    expect(
      buildXccyCurvesRequest({
        universe: [{
          curveDefinition: {
            ...xccyCurveDefFromPublished(pln!),
            mainConstituentAssetClass: 'FxForward',
            name: 'USD PLN FxForward',
            id: pln!.id,
          },
        }],
      }).universe,
    ).toEqual([{
      curveDefinition: {
        baseCurrency: 'USD',
        baseIndexName: 'LIBOR',
        quotedCurrency: 'PLN',
        quotedIndexName: 'WIBOR',
        curveTenors: [...XCCY_CURVE_TENORS],
      },
    }]);
  });
});
