'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('sandbox_progress', {
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
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('sandbox_progress');
  },
};
