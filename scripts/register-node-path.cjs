const path = require('path');
const { Module } = require('module');

const nodePath = path.join(__dirname, '..', 'node_modules');
process.env.NODE_PATH = [nodePath, process.env.NODE_PATH]
  .filter(Boolean)
  .join(path.delimiter);
Module._initPaths();
