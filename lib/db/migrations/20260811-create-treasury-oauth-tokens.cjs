'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('treasury_oauth_tokens', {
      user_email: {
        type: Sequelize.STRING(320),
        allowNull: false,
        primaryKey: true,
      },
      access_token_ciphertext: {
        type: Sequelize.TEXT,
        allowNull: false,
      },
      refresh_token_ciphertext: {
        type: Sequelize.TEXT,
        allowNull: false,
      },
      expires_at: {
        type: Sequelize.DATE,
        allowNull: false,
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
    await queryInterface.dropTable('treasury_oauth_tokens');
  },
};
