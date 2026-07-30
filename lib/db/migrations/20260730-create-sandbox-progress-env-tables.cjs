'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const columns = {
      user_email: {
        type: Sequelize.STRING(320),
        allowNull: false,
        primaryKey: true,
      },
      task_id: {
        type: Sequelize.STRING(32),
        allowNull: false,
        primaryKey: true,
      },
      state: {
        type: Sequelize.JSONB,
        allowNull: false,
      },
      version: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 1,
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
      },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
      },
    };

    await queryInterface.createTable('sandbox_progress_uat', columns);
    await queryInterface.createTable('sandbox_progress_production', columns);
  },

  async down(queryInterface) {
    await queryInterface.dropTable('sandbox_progress_production');
    await queryInterface.dropTable('sandbox_progress_uat');
  },
};
