'use strict';

/**
 * Persistent capture of Workbench / sandbox desk actions.
 * Same UAT vs production split as sandbox_progress_*.
 *
 *   desk_workspace_*  — Entity → Dashboard → RiskProfile tree
 *   desk_fx_book_*    — live FX Risk book (rows, layers, shared rates)
 *   desk_liquidity_*  — forecast path + sizing / booking regime
 *   desk_analytics_*  — VaR setup, staged packages, carry sessions, curves
 *   desk_hedge_*      — Hedging Decision book (tickets, ratios, prepared)
 *   desk_action_*     — append-only log of user actions
 */

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const envSuffixes = ['uat', 'production'];

    const snapshotMeta = {
      user_email: {
        type: Sequelize.STRING(320),
        allowNull: false,
        primaryKey: true,
      },
      desk_scope: {
        type: Sequelize.STRING(64),
        allowNull: false,
        primaryKey: true,
      },
      version: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 1,
      },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    };

    for (const env of envSuffixes) {
      await queryInterface.createTable(`desk_workspace_${env}`, {
        ...snapshotMeta,
        workspace: { type: Sequelize.JSONB, allowNull: false },
      });

      await queryInterface.createTable(`desk_fx_book_${env}`, {
        ...snapshotMeta,
        dashboard_id: {
          type: Sequelize.STRING(64),
          allowNull: false,
          primaryKey: true,
        },
        entity_id: { type: Sequelize.STRING(64), allowNull: true },
        rows: { type: Sequelize.JSONB, allowNull: false, defaultValue: [] },
        usd_cash: { type: Sequelize.DOUBLE, allowNull: true },
        usd_non_lp_cash: { type: Sequelize.DOUBLE, allowNull: true },
        usd_params: { type: Sequelize.JSONB, allowNull: true },
        shared: { type: Sequelize.JSONB, allowNull: true },
        active_layers: { type: Sequelize.JSONB, allowNull: true },
        policy_var: { type: Sequelize.DOUBLE, allowNull: true },
        formulas: { type: Sequelize.JSONB, allowNull: true },
      });

      await queryInterface.createTable(`desk_liquidity_${env}`, {
        ...snapshotMeta,
        dashboard_id: {
          type: Sequelize.STRING(64),
          allowNull: false,
          primaryKey: true,
        },
        entity_id: { type: Sequelize.STRING(64), allowNull: true },
        forecast_profile: { type: Sequelize.JSONB, allowNull: true },
        timing: { type: Sequelize.JSONB, allowNull: true },
        sizing_basis: { type: Sequelize.STRING(32), allowNull: true },
        booking_mode: { type: Sequelize.STRING(32), allowNull: true },
        active_layers: { type: Sequelize.JSONB, allowNull: true },
      });

      await queryInterface.createTable(`desk_analytics_${env}`, {
        ...snapshotMeta,
        dashboard_id: {
          type: Sequelize.STRING(64),
          allowNull: false,
          primaryKey: true,
        },
        entity_id: { type: Sequelize.STRING(64), allowNull: true },
        var_setup: { type: Sequelize.JSONB, allowNull: true },
        prepared_by_ccy: { type: Sequelize.JSONB, allowNull: true },
        carry_sessions: { type: Sequelize.JSONB, allowNull: true },
        market_rates: { type: Sequelize.JSONB, allowNull: true },
      });

      await queryInterface.createTable(`desk_hedge_${env}`, {
        ...snapshotMeta,
        scope_id: {
          type: Sequelize.STRING(64),
          allowNull: false,
          primaryKey: true,
        },
        booked_hedges: { type: Sequelize.JSONB, allowNull: false, defaultValue: [] },
        hedge_ratios: { type: Sequelize.JSONB, allowNull: false, defaultValue: {} },
        prepared_by_ccy: { type: Sequelize.JSONB, allowNull: true },
        carry_sessions: { type: Sequelize.JSONB, allowNull: true },
        market_rates: { type: Sequelize.JSONB, allowNull: true },
      });

      await queryInterface.createTable(`desk_action_${env}`, {
        id: {
          type: Sequelize.BIGINT,
          autoIncrement: true,
          primaryKey: true,
        },
        user_email: { type: Sequelize.STRING(320), allowNull: false },
        desk_scope: { type: Sequelize.STRING(64), allowNull: false },
        dashboard_id: { type: Sequelize.STRING(64), allowNull: true },
        scope_id: { type: Sequelize.STRING(64), allowNull: true },
        module: { type: Sequelize.STRING(32), allowNull: false },
        action: { type: Sequelize.STRING(64), allowNull: false },
        payload: { type: Sequelize.JSONB, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false },
      });

      await queryInterface.addIndex(`desk_action_${env}`, ['user_email', 'created_at'], {
        name: `desk_action_${env}_user_created_idx`,
      });
      await queryInterface.addIndex(`desk_action_${env}`, ['user_email', 'module', 'created_at'], {
        name: `desk_action_${env}_user_module_idx`,
      });
    }
  },

  async down(queryInterface) {
    for (const env of ['production', 'uat']) {
      await queryInterface.dropTable(`desk_action_${env}`);
      await queryInterface.dropTable(`desk_hedge_${env}`);
      await queryInterface.dropTable(`desk_analytics_${env}`);
      await queryInterface.dropTable(`desk_liquidity_${env}`);
      await queryInterface.dropTable(`desk_fx_book_${env}`);
      await queryInterface.dropTable(`desk_workspace_${env}`);
    }
  },
};
